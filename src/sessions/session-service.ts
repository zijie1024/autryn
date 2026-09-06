import type { NonSystemMessage } from "@/core";
import {
  CONTEXT_SUMMARY_SCHEMA_VERSION,
  type ContextStateUpdate,
} from "@/runtime/context";
import { expandCompletedPhaseCheckpoints, validateFrontier } from "@/runtime/context/frontier";
import type {
  ExecutionBranchResult,
  ExecutionResult,
  ExecutionTerminalStatus,
  HandoffRecord,
} from "@/runtime/execution/types";

import { scrubSensitiveText, SessionError } from "./errors";
import { normalizeSessionName, projectKeyFromCwd, sanitizeMessageForPersistence } from "./session-schema";
import type {
  Clock,
  ContextCompactionCheckpoint,
  IdFactory,
  ModelConfigId,
  LoadedSession,
  PersistedSessionMessage,
  PersistedTurn,
  SessionRecord,
  SessionStore,
} from "./session-types";

export interface SessionServiceOptions {
  store: SessionStore;
  clock?: Clock;
  ids?: Partial<IdFactory>;
}

export class SessionService {
  private readonly store: SessionStore;
  private readonly clock: Clock;
  private readonly ids: IdFactory;

  constructor(options: SessionServiceOptions) {
    this.store = options.store;
    this.clock = options.clock ?? { now: () => new Date().toISOString() };
    this.ids = {
      sessionId: options.ids?.sessionId ?? (() => crypto.randomUUID()),
      turnId: options.ids?.turnId ?? (() => crypto.randomUUID()),
      messageId: options.ids?.messageId ?? (() => crypto.randomUUID()),
      ownerId: options.ids?.ownerId ?? (() => crypto.randomUUID()),
    };
  }

  createDraft(input: {
    cwd: string;
    name?: string | null;
    activeAgentId: string;
    activeAgentGroupId: string;
    agentModelOverrides?: Record<string, ModelConfigId>;
    activeExecutionMode?: "execute" | "dry_run";
  }): LoadedSession {
    const now = this.clock.now();
    return {
      id: this.ids.sessionId(),
      name: input.name ? normalizeSessionName(input.name) : null,
      createdAt: now,
      updatedAt: now,
      workspace: { cwd: input.cwd, projectKey: projectKeyFromCwd(input.cwd) },
      activeAgentId: input.activeAgentId,
      activeAgentGroupId: input.activeAgentGroupId,
      agentModelOverrides: input.agentModelOverrides ?? {},
      activeExecutionMode: input.activeExecutionMode ?? "execute",
      materialized: false,
    };
  }

  async materialize(draft: LoadedSession): Promise<SessionRecord> {
    if (!("materialized" in draft)) return draft;
    const now = this.clock.now();
    const record: SessionRecord = {
      id: draft.id,
      revision: 1,
      name: draft.name,
      createdAt: draft.createdAt,
      updatedAt: now,
      workspace: draft.workspace,
      activeAgentId: draft.activeAgentId,
      activeAgentGroupId: draft.activeAgentGroupId,
      agentModelOverrides: draft.agentModelOverrides,
      activeExecutionMode: draft.activeExecutionMode,
      messages: [],
      turns: [],
      compaction: emptyCompactionState(1, now),
    };
    return this.store.create(record);
  }

  async rename(session: LoadedSession, name: string): Promise<SessionRecord> {
    const record = await this.materialize(session);
    return this.store.mutate(record.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      name: normalizeSessionName(name),
      updatedAt: this.clock.now(),
    }));
  }

  async setAgentModelOverride(
    session: LoadedSession,
    agentId: string,
    modelConfigId: ModelConfigId,
  ): Promise<SessionRecord> {
    const record = await this.materialize(session);
    return this.store.mutate(record.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      agentModelOverrides: { ...current.agentModelOverrides, [agentId]: modelConfigId },
      updatedAt: this.clock.now(),
    }));
  }

  async setActiveExecutionMode(
    session: LoadedSession,
    activeExecutionMode: "execute" | "dry_run",
  ): Promise<SessionRecord> {
    const record = await this.materialize(session);
    return this.store.mutate(record.id, (current) => ({
      ...current,
      revision: current.revision + 1,
      activeExecutionMode,
      updatedAt: this.clock.now(),
    }));
  }

  async clear(session: LoadedSession): Promise<SessionRecord> {
    const record = await this.materialize(session);
    return this.store.mutate(
      record.id,
      (current) => {
        const now = this.clock.now();
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: now,
          messages: [],
          compaction: emptyCompactionState(current.revision + 1, now),
          turns: current.turns.map((turn) => (turn.status === "running" ? interruptedTurn(turn, now) : turn)),
        };
      },
      { operation: "clear" },
    );
  }

  async beginTurn(
    session: LoadedSession,
    group: { id: string; revision: string },
  ): Promise<{ record: SessionRecord; turn: PersistedTurn }> {
    const record = await this.materialize(session);
    let turn!: PersistedTurn;
    const next = await this.store.mutate(record.id, (current) => {
      const now = this.clock.now();
      turn = {
        id: this.ids.turnId(),
        status: "running",
        startedAt: now,
        executionMode: current.activeExecutionMode,
        initialAgentId: current.activeAgentId,
        handoffs: [],
        agentGroupId: group.id,
        agentGroupRevision: group.revision,
        effectiveModels: [],
      };
      return { ...current, revision: current.revision + 1, updatedAt: now, turns: [...current.turns, turn] };
    });
    return { record: next, turn };
  }

  prepareMessages(turnId: string, messages: NonSystemMessage[]): PersistedSessionMessage[] {
    const committedAt = this.clock.now();
    return messages.map((message) => ({
      id: this.ids.messageId(),
      turnId,
      committedAt,
      message: sanitizeMessageForPersistence(message),
    }));
  }

  async startTurn(
    session: LoadedSession,
    group: { id: string; revision: string },
    userMessage: NonSystemMessage,
    contextPolicyVersion?: string,
  ): Promise<{ record: SessionRecord; turn: PersistedTurn }> {
    const turnId = this.ids.turnId();
    const persistedUserMessage = this.prepareMessages(turnId, [userMessage])[0]!;
    const build = (current: SessionRecord): { record: SessionRecord; turn: PersistedTurn } => {
      const now = this.clock.now();
      const revision = current.revision + 1;
      const turn: PersistedTurn = {
        id: turnId,
        status: "running",
        startedAt: now,
        executionMode: current.activeExecutionMode,
        initialAgentId: current.activeAgentId,
        handoffs: [],
        agentGroupId: group.id,
        agentGroupRevision: group.revision,
        effectiveModels: [],
      };
      let compaction = current.compaction;
      if (contextPolicyVersion && !current.compaction.phases.some((phase) => phase.status === "active")) {
        const phaseId = this.ids.turnId();
        const nextObjective = current.compaction.checkpoint.nextPhaseObjective;
        compaction = {
          version: 1,
          phases: [
            ...current.compaction.phases,
            {
              id: phaseId,
              status: "active",
              objective: nextObjective ?? "Initial phase",
              startedTurnId: turnId,
              createdAt: now,
            },
          ],
          nodes: current.compaction.nodes,
          checkpoint: {
            sourceRevision: revision,
            frontierNodeIds: current.compaction.checkpoint.frontierNodeIds,
            activePhaseId: phaseId,
            nextPhaseObjective: null,
            policyVersion: contextPolicyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        };
      }
      return {
        turn,
        record: {
          ...current,
          revision,
          updatedAt: now,
          messages: appendUniqueMessages(current.messages, [persistedUserMessage]),
          turns: [...current.turns, turn],
          compaction,
        },
      };
    };

    if ("materialized" in session) {
      const now = this.clock.now();
      const initial: SessionRecord = {
        id: session.id,
        revision: 0,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: now,
        workspace: session.workspace,
        activeAgentId: session.activeAgentId,
        activeAgentGroupId: session.activeAgentGroupId,
        agentModelOverrides: session.agentModelOverrides,
        activeExecutionMode: session.activeExecutionMode,
        messages: [],
        turns: [],
        compaction: emptyCompactionState(1, now),
      };
      const started = build(initial);
      return { record: await this.store.create(started.record), turn: started.turn };
    }

    let turn!: PersistedTurn;
    const next = await this.store.mutate(session.id, (current) => {
      const started = build(current);
      turn = started.turn;
      return started.record;
    });
    return { record: next, turn };
  }

  async appendMessages(sessionId: string, turnId: string, messages: NonSystemMessage[]): Promise<SessionRecord> {
    return this.checkpointTurn(sessionId, turnId, { messages: this.prepareMessages(turnId, messages) });
  }

  async checkpointTurn(
    sessionId: string,
    turnId: string,
    input: {
      messages?: PersistedSessionMessage[];
      effectiveModels?: PersistedTurn["effectiveModels"];
    },
  ): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const turn = current.turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.status !== "running") {
        throw new SessionError("INVALID_SESSION_RECORD", `Turn ${turnId} is not running.`);
      }
      const messages = appendUniqueMessages(
        current.messages,
        (input.messages ?? []).filter((message) => message.turnId === turnId),
      ).slice(current.messages.length);
      const existingModelIds = new Set(turn.effectiveModels.map((model) => model.executionId));
      const effectiveModels = (input.effectiveModels ?? []).filter(
        (model) => !existingModelIds.has(model.executionId),
      );
      if (messages.length === 0 && effectiveModels.length === 0) return null;
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.clock.now(),
        messages: [...current.messages, ...messages],
        turns: current.turns.map((candidate) =>
          candidate.id === turnId
            ? { ...candidate, effectiveModels: [...candidate.effectiveModels, ...effectiveModels] }
            : candidate,
        ),
      };
      return next;
    });
  }

  async commitHandoff(
    sessionId: string,
    turnId: string,
    input: {
      messages?: PersistedSessionMessage[];
      effectiveModels?: PersistedTurn["effectiveModels"];
      handoff: HandoffRecord;
    },
  ): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const now = this.clock.now();
      const turn = current.turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.status !== "running") {
        throw new SessionError("INVALID_SESSION_RECORD", `Turn ${turnId} is not running.`);
      }
      const messages = appendUniqueMessages(
        current.messages,
        (input.messages ?? []).filter((message) => message.turnId === turnId),
      ).slice(current.messages.length);
      const existingModelIds = new Set(turn.effectiveModels.map((model) => model.executionId));
      const effectiveModels = (input.effectiveModels ?? []).filter(
        (model) => !existingModelIds.has(model.executionId),
      );
      const handoffs = turn.handoffs ?? [];
      const alreadyRecorded = handoffs.some(
        (candidate) => candidate.successorExecutionId === input.handoff.successorExecutionId,
      );
      if (alreadyRecorded && messages.length === 0 && effectiveModels.length === 0) return null;
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        activeAgentId: input.handoff.targetAgentId,
        messages: [...current.messages, ...messages],
        turns: current.turns.map((candidate) =>
          candidate.id !== turnId
            ? candidate
            : {
                ...candidate,
                handoffs: alreadyRecorded ? handoffs : [...handoffs, input.handoff],
                effectiveModels: [...candidate.effectiveModels, ...effectiveModels],
              },
        ),
      };
      return next;
    });
  }

  async recordHandoff(sessionId: string, turnId: string, record: HandoffRecord): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const now = this.clock.now();
      let found = false;
      let changed = false;
      const turns = current.turns.map((turn) => {
        if (turn.id !== turnId) return turn;
        found = true;
        if (turn.status !== "running") {
          throw new SessionError("INVALID_SESSION_RECORD", `Turn ${turnId} is not running.`);
        }
        const handoffs = turn.handoffs ?? [];
        if (handoffs.some((candidate) => candidate.successorExecutionId === record.successorExecutionId)) {
          return turn;
        }
        changed = true;
        return { ...turn, handoffs: [...handoffs, record] };
      });
      if (!found) throw new SessionError("SESSION_NOT_FOUND", `Turn ${turnId} was not found.`);
      if (!changed) return null;
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        activeAgentId: record.targetAgentId,
        turns,
      };
      return next;
    });
  }

  async finishTurn(
    sessionId: string,
    turnId: string,
    result: ExecutionResult | ExecutionBranchResult,
    effectiveModels: PersistedTurn["effectiveModels"] = [],
    options: {
      messages?: PersistedSessionMessage[];
      phaseTransition?: { nextObjective: string; policyVersion: string };
    } = {},
  ): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const now = this.clock.now();
      const messages = appendUniqueMessages(
        current.messages,
        (options.messages ?? []).filter((message) => message.turnId === turnId),
      ).slice(current.messages.length);
      const persistedMessages = repairIncompleteToolUses(
        [...current.messages, ...messages],
        new Set([turnId]),
        now,
        () => this.ids.messageId(),
      );
      const turns = current.turns.map((turn) => {
        if (turn.id !== turnId) return turn;
        return {
          ...turn,
          status: toTurnStatus(result.status),
          finishedAt: now,
          rootExecutionId: result.rootExecutionId,
          executionMode: result.mode,
          initialAgentId: "initialAgentId" in result ? result.initialAgentId : result.agentId,
          finalAgentId: "finalAgentId" in result ? result.finalAgentId : result.agentId,
          handoffs: "handoffs" in result ? result.handoffs : [],
          effectiveModels: mergeEffectiveModels(turn.effectiveModels, effectiveModels),
          ...(result.mode === "dry_run" && "dryRunReport" in result && result.dryRunReport
            ? { dryRunReport: result.dryRunReport }
            : {}),
          usage: result.usage,
          ...(result.error
            ? { error: { code: result.error.code, message: scrubSensitiveText(result.error.message) } }
            : {}),
        } satisfies PersistedTurn;
      });
      if (turns.every((turn) => turn.id !== turnId)) {
        throw new SessionError("SESSION_NOT_FOUND", `Turn ${turnId} was not found.`);
      }
      const handoffResult = "handoffs" in result && result.handoffs.length > 0;
      const revision = current.revision + 1;
      let compaction = current.compaction;
      if (options.phaseTransition && result.status === "completed") {
        const completedPhaseIds = new Set(
          current.compaction.phases.filter((phase) => phase.status === "active").map((phase) => phase.id),
        );
        const frontierNodeIds = expandCompletedPhaseCheckpoints(
          current.compaction.checkpoint.frontierNodeIds,
          current.compaction.nodes,
          completedPhaseIds,
        );
        if (!frontierNodeIds) {
          throw new SessionError("INVALID_SESSION_RECORD", "Completed Phase checkpoint cannot be expanded safely.");
        }
        compaction = {
          version: 1,
          phases: current.compaction.phases.map((phase) =>
            phase.status === "active"
              ? { ...phase, status: "completed" as const, endedTurnId: turnId, completedAt: now }
              : phase,
          ),
          nodes: current.compaction.nodes,
          checkpoint: {
            sourceRevision: revision,
            frontierNodeIds,
            activePhaseId: null,
            nextPhaseObjective: options.phaseTransition.nextObjective,
            policyVersion: options.phaseTransition.policyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        };
      }
      const next = {
        ...current,
        revision,
        updatedAt: now,
        messages: persistedMessages,
        ...(handoffResult && "finalAgentId" in result ? { activeAgentId: result.finalAgentId } : {}),
        turns,
        compaction,
      };
      return next;
    });
  }

  async appendEffectiveModel(
    sessionId: string,
    turnId: string,
    model: PersistedTurn["effectiveModels"][number],
  ): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const turn = current.turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.status !== "running") return null;
      if (turn.effectiveModels.some((candidate) => candidate.executionId === model.executionId)) return null;
      const next: SessionRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: this.clock.now(),
        turns: current.turns.map((candidate) =>
          candidate.id === turnId
            ? { ...candidate, effectiveModels: [...candidate.effectiveModels, model] }
            : candidate,
        ),
      };
      return next;
    });
  }

  async commitCompactionState(sessionId: string, update: ContextStateUpdate): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      if (update.checkpoint.sourceRevision > current.revision) {
        throw new SessionError("INVALID_SESSION_RECORD", "Compaction checkpoint comes from a future Session revision.");
      }
      const nodeById = new Map(current.compaction.nodes.map((node) => [node.id, node]));
      for (const node of update.appendNodes) {
        const existing = nodeById.get(node.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(node)) {
          throw new SessionError("INVALID_SESSION_RECORD", `Compaction node ${node.id} conflicts with existing state.`);
        }
        nodeById.set(node.id, node);
      }
      const nodes = [...nodeById.values()];
      const sources = sessionContextSources(current);
      const phases = current.compaction.phases.map((phase) => ({
        id: phase.id,
        status: phase.status,
        startedTurnId: phase.startedTurnId,
        ...(phase.endedTurnId ? { endedTurnId: phase.endedTurnId } : {}),
      }));
      const checkpointValid = validateFrontier({
        checkpoint: update.checkpoint,
        nodes,
        sources,
        phases,
        currentSourceRevision: current.revision,
        expectedSummarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
        requireStableAnchors: true,
      });
      if (
        !checkpointValid ||
        update.appendNodes.some((node) => !checkpointValid.reachableNodeIds.has(node.id))
      ) {
        throw new SessionError("INVALID_SESSION_RECORD", "Compaction checkpoint does not cover a valid source frontier.");
      }
      const unchanged =
        JSON.stringify(current.compaction.nodes) === JSON.stringify(nodes) &&
        sameCheckpoint(current.compaction.checkpoint, update.checkpoint);
      if (unchanged) return null;
      const now = this.clock.now();
      return {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        compaction: { version: 1, phases: current.compaction.phases, nodes, checkpoint: update.checkpoint },
      };
    });
  }

  async ensureCompactionState(sessionId: string, turnId: string, policyVersion: string): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const now = this.clock.now();
      const hasActivePhase = current.compaction.phases.some((phase) => phase.status === "active");
      if (hasActivePhase) return null;
      const nextObjective = current.compaction.checkpoint.nextPhaseObjective;
      const phaseId = this.ids.turnId();
      const next: SessionRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        compaction: {
          version: 1,
          phases: [
            ...current.compaction.phases,
            {
              id: phaseId,
              status: "active",
              objective: nextObjective ?? "Initial phase",
              startedTurnId: turnId,
              createdAt: now,
            },
          ],
          nodes: current.compaction.nodes,
          checkpoint: {
            sourceRevision: current.revision,
            frontierNodeIds: current.compaction.checkpoint.frontierNodeIds,
            activePhaseId: phaseId,
            nextPhaseObjective: null,
            policyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        },
      };
      return next;
    });
  }

  async transitionCompactionPhase(
    sessionId: string,
    turnId: string,
    nextObjective: string,
    policyVersion: string,
  ): Promise<SessionRecord> {
    return this.store.mutate(sessionId, (current) => {
      const now = this.clock.now();
      const completedPhaseIds = new Set(
        current.compaction.phases.filter((phase) => phase.status === "active").map((phase) => phase.id),
      );
      const frontierNodeIds = expandCompletedPhaseCheckpoints(
        current.compaction.checkpoint.frontierNodeIds,
        current.compaction.nodes,
        completedPhaseIds,
      );
      if (!frontierNodeIds) {
        throw new SessionError("INVALID_SESSION_RECORD", "Completed Phase checkpoint cannot be expanded safely.");
      }
      const phases = current.compaction.phases.map((phase) =>
        phase.status === "active"
          ? { ...phase, status: "completed" as const, endedTurnId: turnId, completedAt: now }
          : phase,
      );
      const next: SessionRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        compaction: {
          version: 1,
          phases,
          nodes: current.compaction.nodes,
          checkpoint: {
            sourceRevision: current.revision + 1,
            frontierNodeIds,
            activePhaseId: null,
            nextPhaseObjective: nextObjective,
            policyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        },
      };
      return next;
    });
  }

  async repairInterrupted(record: SessionRecord): Promise<SessionRecord> {
    return this.store.mutate(record.id, (current) => {
      const runningTurnIds = new Set(
        current.turns.filter((turn) => turn.status === "running").map((turn) => turn.id),
      );
      if (runningTurnIds.size === 0) return null;
      const now = this.clock.now();
      const messages = repairIncompleteToolUses(
        current.messages,
        runningTurnIds,
        now,
        () => this.ids.messageId(),
      );
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        messages,
        turns: current.turns.map((turn) => (turn.status === "running" ? interruptedTurn(turn, now) : turn)),
      };
      return next;
    });
  }
}

function repairIncompleteToolUses(
  messages: PersistedSessionMessage[],
  runningTurnIds: ReadonlySet<string>,
  committedAt: string,
  createMessageId: () => string,
): PersistedSessionMessage[] {
  const result: PersistedSessionMessage[] = [];
  const messageIds = new Set(messages.map((message) => message.id));

  for (let index = 0; index < messages.length; index++) {
    const entry = messages[index]!;
    result.push(entry);
    if (entry.message.role !== "assistant" || !runningTurnIds.has(entry.turnId)) continue;

    const toolUses = entry.message.content.filter((content) => content.type === "tool_use");
    if (toolUses.length === 0) continue;

    const toolUseIds = new Set(toolUses.map((toolUse) => toolUse.id));
    const completed = new Set<string>();
    while (index + 1 < messages.length) {
      const candidate = messages[index + 1]!;
      if (candidate.message.role !== "tool") break;
      const matched = candidate.message.content.filter((content) => toolUseIds.has(content.tool_use_id));
      if (matched.length === 0) break;
      for (const content of matched) completed.add(content.tool_use_id);
      result.push(candidate);
      index++;
    }

    const missing = toolUses.filter((toolUse) => !completed.has(toolUse.id));
    if (missing.length === 0) continue;

    let id = createMessageId();
    while (messageIds.has(id)) id = crypto.randomUUID();
    messageIds.add(id);
    result.push({
      id,
      turnId: entry.turnId,
      committedAt,
      message: {
        role: "tool",
        content: missing.map((toolUse) => ({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify({
            ok: false,
            code: "EXECUTION_INTERRUPTED",
            error: "Tool execution ended before a durable result was recorded.",
          }),
        })),
      },
    });
  }

  return result;
}

function interruptedTurn(turn: PersistedTurn, finishedAt: string): PersistedTurn {
  return {
    ...turn,
    status: "interrupted",
    finishedAt,
    error: {
      code: "PROCESS_INTERRUPTED",
      message: "The previous process ended before this turn reached a saved terminal state.",
    },
  };
}

function toTurnStatus(status: ExecutionTerminalStatus): PersistedTurn["status"] {
  if (status === "timed_out") return "timed_out";
  if (status === "handed_off") return "interrupted";
  return status;
}

function mergeEffectiveModels(
  current: PersistedTurn["effectiveModels"],
  incoming: PersistedTurn["effectiveModels"],
): PersistedTurn["effectiveModels"] {
  const byExecutionId = new Map(current.map((model) => [model.executionId, model]));
  for (const model of incoming) byExecutionId.set(model.executionId, model);
  return [...byExecutionId.values()];
}

function appendUniqueMessages(
  current: PersistedSessionMessage[],
  incoming: PersistedSessionMessage[],
): PersistedSessionMessage[] {
  const result = [...current];
  const byId = new Map(result.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (existing) {
      if (JSON.stringify(existing.message) === JSON.stringify(message.message)) continue;
      let id = crypto.randomUUID();
      while (byId.has(id)) id = crypto.randomUUID();
      const unique = { ...message, id };
      result.push(unique);
      byId.set(id, unique);
      continue;
    }
    result.push(message);
    byId.set(message.id, message);
  }
  return result;
}

function emptyCompactionState(sourceRevision: number, now: string) {
  return {
    version: 1 as const,
    phases: [],
    nodes: [],
    checkpoint: {
      sourceRevision,
      frontierNodeIds: [],
      activePhaseId: null,
      nextPhaseObjective: null,
      policyVersion: "context-v1",
      summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      updatedAt: now,
    } satisfies ContextCompactionCheckpoint,
  };
}

function sessionContextSources(session: SessionRecord) {
  const turnIndexById = new Map<string, number>();
  const turnIds: string[] = [];
  for (const message of session.messages) {
    if (!turnIndexById.has(message.turnId)) {
      turnIndexById.set(message.turnId, turnIndexById.size);
      turnIds.push(message.turnId);
    }
  }
  const phaseByTurnId = new Map<string, { id: string; status: "active" | "completed" }>();
  for (const phase of session.compaction.phases) {
    const start = turnIndexById.get(phase.startedTurnId);
    const end = phase.endedTurnId ? turnIndexById.get(phase.endedTurnId) : turnIds.length - 1;
    if (start === undefined || end === undefined) continue;
    for (let turnIndex = start; turnIndex <= end; turnIndex++) {
      const turnId = turnIds[turnIndex];
      if (turnId) phaseByTurnId.set(turnId, { id: phase.id, status: phase.status });
    }
  }
  return session.messages.map((entry) => {
    const phase = phaseByTurnId.get(entry.turnId);
    return {
      messageId: entry.id,
      turnId: entry.turnId,
      turnIndex: turnIndexById.get(entry.turnId) ?? 0,
      ...(phase ? { phaseId: phase.id, phaseStatus: phase.status } : {}),
      sourceRevision: session.revision,
    };
  });
}

function sameCheckpoint(
  left: SessionRecord["compaction"]["checkpoint"],
  right: SessionRecord["compaction"]["checkpoint"],
): boolean {
  return (
    left.sourceRevision === right.sourceRevision &&
    JSON.stringify(left.frontierNodeIds) === JSON.stringify(right.frontierNodeIds) &&
    (left.activePhaseId ?? null) === (right.activePhaseId ?? null) &&
    (left.nextPhaseObjective ?? null) === (right.nextPhaseObjective ?? null) &&
    left.policyVersion === right.policyVersion &&
    left.summarySchemaVersion === right.summarySchemaVersion
  );
}
