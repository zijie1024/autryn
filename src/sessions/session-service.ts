import type { NonSystemMessage } from "@/core";
import { CONTEXT_SUMMARY_SCHEMA_VERSION, type CompactionNode } from "@/runtime/context";
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
  DurableClearSessionStore,
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
    const lease = await this.store.acquire(draft.id, { create: true });
    try {
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
      await this.store.commit(lease, 0, record);
      return record;
    } finally {
      await lease.release();
    }
  }

  async rename(session: LoadedSession, name: string): Promise<SessionRecord> {
    const record = await this.materialize(session);
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const next = {
        ...current,
        revision: current.revision + 1,
        name: normalizeSessionName(name),
        updatedAt: this.clock.now(),
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async setAgentModelOverride(
    session: LoadedSession,
    agentId: string,
    modelConfigId: ModelConfigId,
  ): Promise<SessionRecord> {
    const record = await this.materialize(session);
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const next = {
        ...current,
        revision: current.revision + 1,
        agentModelOverrides: { ...current.agentModelOverrides, [agentId]: modelConfigId },
        updatedAt: this.clock.now(),
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async setActiveExecutionMode(
    session: LoadedSession,
    activeExecutionMode: "execute" | "dry_run",
  ): Promise<SessionRecord> {
    const record = await this.materialize(session);
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const next = { ...current, revision: current.revision + 1, activeExecutionMode, updatedAt: this.clock.now() };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async clear(session: LoadedSession): Promise<SessionRecord> {
    const record = await this.materialize(session);
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const now = this.clock.now();
      const next: SessionRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        messages: [],
        compaction: emptyCompactionState(current.revision, now),
        turns: current.turns.map((turn) => (turn.status === "running" ? interruptedTurn(turn, now) : turn)),
      };
      const store = this.store;
      if (isDurableClearStore(store)) {
        await store.commitClear(lease, current.revision, next);
      } else {
        await store.commit(lease, current.revision, next);
      }
      return next;
    } finally {
      await lease.release();
    }
  }

  async beginTurn(
    session: LoadedSession,
    group: { id: string; revision: string },
  ): Promise<{ record: SessionRecord; turn: PersistedTurn }> {
    const record = await this.materialize(session);
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const now = this.clock.now();
      const turn: PersistedTurn = {
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
      const next = { ...current, revision: current.revision + 1, updatedAt: now, turns: [...current.turns, turn] };
      await this.store.commit(lease, current.revision, next);
      return { record: next, turn };
    } finally {
      await lease.release();
    }
  }

  async appendMessages(sessionId: string, turnId: string, messages: NonSystemMessage[]): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
      const persisted: PersistedSessionMessage[] = messages.map((message) => ({
        id: this.ids.messageId(),
        turnId,
        committedAt: now,
        message: sanitizeMessageForPersistence(message),
      }));
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        messages: [...current.messages, ...persisted],
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async recordHandoff(sessionId: string, turnId: string, record: HandoffRecord): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
      let found = false;
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
        return { ...turn, handoffs: [...handoffs, record] };
      });
      if (!found) throw new SessionError("SESSION_NOT_FOUND", `Turn ${turnId} was not found.`);
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        activeAgentId: record.targetAgentId,
        turns,
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async finishTurn(
    sessionId: string,
    turnId: string,
    result: ExecutionResult | ExecutionBranchResult,
    effectiveModels: PersistedTurn["effectiveModels"] = [],
  ): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
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
          effectiveModels,
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
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        ...(handoffResult && "finalAgentId" in result ? { activeAgentId: result.finalAgentId } : {}),
        turns,
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async appendEffectiveModel(
    sessionId: string,
    turnId: string,
    model: PersistedTurn["effectiveModels"][number],
  ): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const turn = current.turns.find((candidate) => candidate.id === turnId);
      if (!turn || turn.status !== "running") return current;
      if (turn.effectiveModels.some((candidate) => candidate.executionId === model.executionId)) return current;
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
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async appendCompactionNodes(
    sessionId: string,
    input: {
      nodes: CompactionNode[];
      frontierNodeIds: string[];
      policyVersion: string;
      summarySchemaVersion: number;
      sourceRevision?: number;
    },
  ): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
      const sourceRevision = input.sourceRevision ?? current.revision;
      const compatible = current.compaction.nodes.filter((node) =>
        isCompatibleCompactionNode(node, input, current, sourceRevision),
      );
      const nodeById = new Map(compatible.map((node) => [node.id, node]));
      for (const node of input.nodes) {
        if (isCompatibleCompactionNode(node, input, current, sourceRevision)) {
          nodeById.set(node.id, node);
        }
      }
      const nodes = [...nodeById.values()];
      const allNodeIds = new Set(nodes.map((node) => node.id));
      if (input.frontierNodeIds.some((id) => !allNodeIds.has(id))) {
        throw new SessionError("INVALID_SESSION_RECORD", "Compaction frontier references an unavailable node.");
      }
      const frontierNodeIds = [...new Set(input.frontierNodeIds)];
      const unchanged =
        sameIds(current.compaction.nodes, nodes) &&
        sameStrings(current.compaction.checkpoint.frontierNodeIds, frontierNodeIds) &&
        current.compaction.checkpoint.policyVersion === input.policyVersion &&
        current.compaction.checkpoint.summarySchemaVersion === input.summarySchemaVersion &&
        current.compaction.checkpoint.sourceRevision === sourceRevision;
      if (unchanged) return current;
      const next: SessionRecord = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        compaction: {
          version: 1,
          phases: current.compaction.phases,
          nodes,
          checkpoint: {
            sourceRevision,
            frontierNodeIds,
            ...(current.compaction.checkpoint.recentStartTurnId
              ? { recentStartTurnId: current.compaction.checkpoint.recentStartTurnId }
              : {}),
            ...(current.compaction.checkpoint.activePhaseId
              ? { activePhaseId: current.compaction.checkpoint.activePhaseId }
              : {}),
            ...(current.compaction.checkpoint.nextPhaseObjective
              ? { nextPhaseObjective: current.compaction.checkpoint.nextPhaseObjective }
              : {}),
            policyVersion: input.policyVersion,
            summarySchemaVersion: input.summarySchemaVersion,
            updatedAt: now,
          },
        },
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async ensureCompactionState(sessionId: string, turnId: string, policyVersion: string): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
      const hasActivePhase = current.compaction.phases.some((phase) => phase.status === "active");
      if (hasActivePhase) return current;
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
            policyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        },
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async transitionCompactionPhase(
    sessionId: string,
    turnId: string,
    nextObjective: string,
    policyVersion: string,
  ): Promise<SessionRecord> {
    const lease = await this.store.acquire(sessionId);
    try {
      const current = await this.store.load(sessionId);
      const now = this.clock.now();
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
            sourceRevision: current.revision,
            frontierNodeIds: current.compaction.checkpoint.frontierNodeIds,
            ...(current.compaction.checkpoint.recentStartTurnId
              ? { recentStartTurnId: current.compaction.checkpoint.recentStartTurnId }
              : {}),
            nextPhaseObjective: nextObjective,
            policyVersion,
            summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
            updatedAt: now,
          },
        },
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }

  async repairInterrupted(record: SessionRecord): Promise<SessionRecord> {
    if (!record.turns.some((turn) => turn.status === "running")) return record;
    const lease = await this.store.acquire(record.id);
    try {
      const current = await this.store.load(record.id);
      const now = this.clock.now();
      const next = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        turns: current.turns.map((turn) => (turn.status === "running" ? interruptedTurn(turn, now) : turn)),
      };
      await this.store.commit(lease, current.revision, next);
      return next;
    } finally {
      await lease.release();
    }
  }
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

function isDurableClearStore(store: SessionStore): store is DurableClearSessionStore {
  return typeof (store as Partial<DurableClearSessionStore>).commitClear === "function";
}

function emptyCompactionState(sourceRevision: number, now: string) {
  return {
    version: 1 as const,
    phases: [],
    nodes: [],
    checkpoint: {
      sourceRevision,
      frontierNodeIds: [],
      policyVersion: "context-v1",
      summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      updatedAt: now,
    } satisfies ContextCompactionCheckpoint,
  };
}

function isCompatibleCompactionNode(
  node: CompactionNode,
  input: { policyVersion: string; summarySchemaVersion: number },
  session: SessionRecord,
  sourceRevision: number,
): boolean {
  if (node.policyVersion !== input.policyVersion || node.summarySchemaVersion !== input.summarySchemaVersion) {
    return false;
  }
  if (node.source.sourceRevision && node.source.sourceRevision > sourceRevision) return false;
  if (!node.source.firstMessageId || !node.source.lastMessageId) return true;

  const firstIndex = session.messages.findIndex((message) => message.id === node.source.firstMessageId);
  const lastIndex = session.messages.findIndex((message) => message.id === node.source.lastMessageId);
  if (firstIndex < 0 || lastIndex < firstIndex) return false;
  if (node.source.firstTurnId && session.messages[firstIndex]?.turnId !== node.source.firstTurnId) return false;
  if (node.source.lastTurnId && session.messages[lastIndex]?.turnId !== node.source.lastTurnId) return false;
  return true;
}

function sameIds(left: CompactionNode[], right: CompactionNode[]): boolean {
  return left.length === right.length && left.every((node, index) => node.id === right[index]?.id);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
