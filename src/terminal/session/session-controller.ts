import { statSync } from "node:fs";
import path from "node:path";

import type { ExecutionMode, NonSystemMessage, UserMessage } from "@/core";
import { shortDigest, shortProjectId } from "@/memory";
import {
  DEFAULT_CONTEXT_POLICY,
  ModelContextSummarizer,
  RuntimeContextManager,
  AgentRuntime,
  type Agent,
  type ContextPhaseState,
  type ContextSourceMessage,
  type ExecutionBranchResult,
  type HandoffEvent,
} from "@/runtime";
import type { AgentEvent } from "@/runtime/events/agent-event";
import type {
  LoadedSession,
  PersistedPhase,
  PersistedSessionMessage,
  SessionLease,
  SessionStore,
  SessionSummary,
} from "@/sessions";
import { resolveSessionSelector, SessionError, SessionService } from "@/sessions";
import { SettingsLoader } from "@/terminal/settings";

import { AgentRegistry, type FrozenAgentGroup } from "./agent-registry";
import { createTerminalMemoryRuntime, type TerminalMemoryStatus } from "./memory-runtime";
import type { ModelResolver, ResolvedModel } from "./model-resolver";
import { SessionCommitCoordinator } from "./session-commit-coordinator";

export interface TerminalConfigurationSource {
  loadTurnConfiguration(): { modelResolver: ModelResolver; agentRegistry: AgentRegistry };
}

export interface SessionControllerOptions {
  store: SessionStore;
  modelResolver: ModelResolver;
  cwd: string;
  session?: LoadedSession;
  lease?: SessionLease;
  initialExecutionMode?: ExecutionMode;
  agentRegistry?: AgentRegistry;
  configurationSource?: TerminalConfigurationSource;
}

export interface SessionControllerSnapshot {
  id: string;
  shortId: string;
  name: string | null;
  displayName: string;
  cwd: string;
  activeModelName: string | null;
  activeModelMissing: boolean;
  activeAgentGroupId: string;
  activeExecutionMode: ExecutionMode;
  activeAgentId: string;
  activeAgentMissing: boolean;
  materialized: boolean;
  execution: "idle" | "running";
  messageCount: number;
  turnCount: number;
}

export class SessionController {
  private readonly service: SessionService;
  private readonly store: SessionStore;
  private modelResolver: ModelResolver;
  private agentRegistry: AgentRegistry;
  private readonly configurationSource?: TerminalConfigurationSource;
  private current: LoadedSession;
  private activeExecution: Agent | null = null;
  private turnInProgress = false;
  private attachedLease: SessionLease | null;

  constructor(options: SessionControllerOptions) {
    this.store = options.store;
    this.service = new SessionService({ store: options.store });
    this.modelResolver = options.modelResolver;
    this.agentRegistry =
      options.agentRegistry ?? new AgentRegistry(options.modelResolver.configuration(), options.modelResolver);
    this.configurationSource = options.configurationSource;
    this.attachedLease = options.lease ?? null;
    this.current =
      options.session ??
      this.service.createDraft({
        cwd: options.cwd,
        activeAgentId: this.agentRegistry.defaultAgentId(),
        activeAgentGroupId: this.agentRegistry.defaultGroupId,
        activeExecutionMode: options.initialExecutionMode ?? "execute",
      });
  }

  get session(): LoadedSession {
    return this.current;
  }

  snapshot(): SessionControllerSnapshot {
    const active = this.tryResolveActive();
    const id = this.current.id;
    const name = this.current.name;
    return {
      id,
      shortId: id.slice(0, 8),
      name,
      displayName: name ?? `Untitled · ${id.slice(0, 8)}`,
      cwd: this.current.workspace.cwd,
      activeModelName: active?.entry.name ?? null,
      activeModelMissing: !active,
      activeAgentGroupId: this.current.activeAgentGroupId,
      activeExecutionMode: this.current.activeExecutionMode,
      activeAgentId: this.current.activeAgentId,
      activeAgentMissing: !this.agentRegistry.hasAgent(this.current.activeAgentGroupId, this.current.activeAgentId),
      materialized: !("materialized" in this.current),
      execution: this.turnInProgress ? "running" : "idle",
      messageCount: this.messages().length,
      turnCount: !("materialized" in this.current) ? this.current.turns.length : 0,
    };
  }

  messages(): NonSystemMessage[] {
    if ("materialized" in this.current) return [];
    return this.current.messages.map((entry) => entry.message);
  }

  async listSessions(includeAllProjects = false): Promise<SessionSummary[]> {
    const sessions = await this.store.list({ includeAllProjects, projectKey: this.current.workspace.projectKey });
    return sessions.map((session) => {
      if (session.health !== "ready") return session;
      if (!this.agentRegistry.hasGroup(session.activeAgentGroupId)) return { ...session, health: "agent_missing" };
      if (!this.agentRegistry.hasAgent(session.activeAgentGroupId, session.activeAgentId))
        return { ...session, health: "agent_missing" };
      try {
        this.agentRegistry.freeze(session.activeAgentGroupId, session.agentModelOverrides);
      } catch {
        return { ...session, health: "model_missing" };
      }
      return session;
    });
  }

  modelDescriptors() {
    return this.modelResolver.listDescriptors();
  }

  /** `/memory` 展示用的只读 Memory 状态；不返回任何 Document 正文。 */
  async memoryStatus(): Promise<TerminalMemoryStatus> {
    const runtime = await createTerminalMemoryRuntime({ cwd: this.current.workspace.cwd });
    if (!runtime) {
      return { enabled: false, layers: [] };
    }
    const emptySnapshot = { materialized: false, documents: [], totalBytes: 0 };
    const projectSnapshot =
      runtime.projectPolicy.access === "none"
        ? emptySnapshot
        : await runtime.service.inspect(runtime.projectScope, runtime.projectPolicy);
    const globalSnapshot =
      runtime.globalPolicy.access === "none"
        ? emptySnapshot
        : await runtime.service.inspect(runtime.globalScope, runtime.globalPolicy);
    const homeMemoryRoot = path.dirname(path.dirname(runtime.storageRoot));
    return {
      enabled: true,
      layers: [
        toMemoryStatusLayer(
          "global",
          "global",
          path.join(homeMemoryRoot, "global"),
          runtime.globalPolicy,
          globalSnapshot,
        ),
        toMemoryStatusLayer(
          "project",
          shortProjectId(runtime.projectScope.projectId),
          runtime.storageRoot,
          runtime.projectPolicy,
          projectSnapshot,
        ),
      ],
    };
  }

  async rename(name: string): Promise<void> {
    this.assertIdle();
    await this.attachDraftBeforeMaterialize();
    this.current = await this.service.rename(this.current, name);
    await this.ensureAttached();
  }

  async clear(): Promise<void> {
    this.assertIdle();
    await this.attachDraftBeforeMaterialize();
    this.current = await this.service.clear(this.current);
    await this.ensureAttached();
  }

  async newDraft(name?: string): Promise<void> {
    this.assertIdle();
    await this.attachedLease?.release().catch(() => {});
    this.attachedLease = null;
    this.current = this.service.createDraft({
      cwd: this.current.workspace.cwd,
      activeAgentId: this.agentRegistry.defaultAgentId(),
      activeAgentGroupId: this.agentRegistry.defaultGroupId,
      activeExecutionMode: this.current.activeExecutionMode,
      name: name || null,
    });
  }

  async switchModel(
    selector: string,
    agentId = this.current.activeAgentId,
  ): Promise<{ appliesAfterCurrentTurn: boolean; modelName: string; agentId: string }> {
    if (!this.agentRegistry.hasAgent(this.current.activeAgentGroupId, agentId)) {
      throw new SessionError("SESSION_AGENT_MISSING", `Agent ${agentId} is not part of the active Agent Group.`);
    }
    const resolved = this.modelResolver.resolveSelector(selector);
    await this.attachDraftBeforeMaterialize();
    this.current = await this.service.setAgentModelOverride(this.current, agentId, resolved.entry.id);
    await this.ensureAttached();
    return { appliesAfterCurrentTurn: this.turnInProgress, modelName: resolved.entry.name, agentId };
  }

  async switchExecutionMode(mode: ExecutionMode): Promise<{ appliesAfterCurrentTurn: boolean; mode: ExecutionMode }> {
    await this.attachDraftBeforeMaterialize();
    this.current = await this.service.setActiveExecutionMode(this.current, mode);
    await this.ensureAttached();
    return { appliesAfterCurrentTurn: this.turnInProgress, mode };
  }

  async resume(selector: string): Promise<void> {
    this.assertIdle();
    const target = resolveSessionSelector(selector, await this.store.list({ includeAllProjects: true }));
    const targetLease = await this.store.acquire(target.id);
    const previousLease = this.attachedLease;
    try {
      const loaded = await this.store.load(target.id);
      this.assertRunnableSession(loaded);
      this.attachedLease = targetLease;
      this.current = await this.service.repairInterrupted(loaded);
      await previousLease?.release().catch(() => {});
    } catch (error) {
      this.attachedLease = previousLease;
      await targetLease.release().catch(() => {});
      throw error;
    }
  }

  async deleteCurrent(): Promise<void> {
    this.assertIdle();
    if ("materialized" in this.current) {
      await this.newDraft();
      return;
    }
    try {
      await this.store.deleteSession(this.current.id);
    } finally {
      if (this.attachedLease) {
        await this.attachedLease.release().catch(() => {});
        this.attachedLease = null;
      }
    }
    this.current = this.service.createDraft({
      cwd: this.current.workspace.cwd,
      activeAgentId: this.agentRegistry.defaultAgentId(),
      activeAgentGroupId: this.agentRegistry.defaultGroupId,
      activeExecutionMode: this.current.activeExecutionMode,
    });
  }

  async runTurn(
    text: string,
    options: {
      requestedSkillName?: string | null;
      requestedMemoryWrite?: boolean;
      onMessage?: (message: NonSystemMessage) => void;
      onProgress?: (event: AgentEvent) => void;
      onHandoff?: (event: HandoffEvent) => void;
    } = {},
  ): Promise<ExecutionBranchResult> {
    if (this.turnInProgress) throw new SessionError("SESSION_BUSY", "A turn is already running.");
    this.turnInProgress = true;
    try {
      return await this.runTurnInternal(text, options);
    } finally {
      this.turnInProgress = false;
    }
  }

  private async runTurnInternal(
    text: string,
    options: {
      requestedSkillName?: string | null;
      requestedMemoryWrite?: boolean;
      onMessage?: (message: NonSystemMessage) => void;
      onProgress?: (event: AgentEvent) => void;
      onHandoff?: (event: HandoffEvent) => void;
    } = {},
  ): Promise<ExecutionBranchResult> {
    if (this.configurationSource) {
      const loaded = this.configurationSource.loadTurnConfiguration();
      this.modelResolver = loaded.modelResolver;
      this.agentRegistry = loaded.agentRegistry;
    }
    if (!directoryExists(this.current.workspace.cwd)) {
      throw new SessionError(
        "SESSION_CWD_MISSING",
        `The session directory no longer exists: ${this.current.workspace.cwd}`,
      );
    }
    if (!this.agentRegistry.hasAgent(this.current.activeAgentGroupId, this.current.activeAgentId)) {
      throw new SessionError("SESSION_AGENT_MISSING", `Agent ${this.current.activeAgentId} is not registered.`);
    }
    const frozenGroup = this.agentRegistry.freeze(this.current.activeAgentGroupId, this.current.agentModelOverrides);
    const activeProfile = frozenGroup.agents.get(this.current.activeAgentId)!;
    const resolved = activeProfile.resolvedModel;
    await this.attachDraftBeforeMaterialize();
    const previousMessages = this.messages();
    const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
    const started = await this.service.startTurn(
      this.current,
      { id: frozenGroup.id, revision: frozenGroup.revision },
      userMessage,
      this.shouldCreateContextManager(resolved) ? DEFAULT_CONTEXT_POLICY.policyVersion : undefined,
    );
    this.current = started.record;
    const turnMode = started.turn.executionMode;
    await this.ensureAttached();
    options.onMessage?.(userMessage);
    const contextState = this.createContextManager(frozenGroup);
    const contextManager = contextState.manager;
    let contextSourceSnapshot = contextState.sources;
    const memoryRuntime = await createTerminalMemoryRuntime({
      cwd: this.current.workspace.cwd,
    });
    const approvalState = { allowedTools: await new SettingsLoader().loadAllowList(this.current.workspace.cwd) };
    let agent: Agent;
    const runtime = new AgentRuntime();
    const coordinator = new SessionCommitCoordinator(this.service, this.current.id, started.turn.id, (record) => {
      this.current = record;
      contextSourceSnapshot = appendContextSources(contextSourceSnapshot, record.messages, record.revision, record.compaction.phases);
      contextManager?.updateSources(
        contextSourceSnapshot,
        record.revision,
        activeContextPhases(record.compaction.phases),
        record.compaction.checkpoint,
      );
    });
    const unsubscribeRuntime = runtime.subscribe((event) => {
      if (event.type === "model_call") {
        const profile = frozenGroup.agents.get(event.agentId);
        if (profile) {
          coordinator.addEffectiveModel({
            executionId: event.executionId,
            agentId: event.agentId,
            ...profile.resolvedModel.effective,
          });
        }
      }
    });
    try {
      agent = await this.agentRegistry.create(this.current.activeAgentId, {
        group: frozenGroup,
        cwd: this.current.workspace.cwd,
        messages: previousMessages,
        contextManager,
        memoryRuntime: memoryRuntime ?? undefined,
        approvalState,
        runtime,
      });
    } catch (error) {
      unsubscribeRuntime();
      const failed = failedBranchResult(this.current.activeAgentId, turnMode, error);
      this.current = await coordinator.finish(failed);
      throw error;
    }
    this.activeExecution = agent;

    try {
      agent.setRequestedSkillName(options.requestedSkillName ?? null);
      const run = agent.execute(userMessage, {
        mode: turnMode,
        onCheckpoint: async (checkpoint) => {
          await coordinator.checkpoint(checkpoint);
        },
      });
      for await (const event of run.events) {
        if (event.type === "message") {
          options.onMessage?.(event.message);
        } else if (event.type === "progress") {
          options.onProgress?.(event);
        } else if (event.type === "context") {
          options.onProgress?.(event);
        } else if (event.type === "handoff") {
          options.onHandoff?.(event);
        }
      }
      const result = await run.result;
      const pendingPhase = contextManager?.consumePendingPhaseTransition();
      this.current = await coordinator.finish(result, {
        finalMessage: result.output?.message,
        ...(result.status === "completed" && pendingPhase
          ? {
              phaseTransition: {
                nextObjective: pendingPhase.objective,
                policyVersion: DEFAULT_CONTEXT_POLICY.policyVersion,
              },
            }
          : {}),
      });
      return result;
    } catch (error) {
      agent.abort();
      const failed = failedBranchResult(started.turn.initialAgentId, turnMode, error);
      this.current = await coordinator.finish(failed);
      throw error;
    } finally {
      agent.setRequestedSkillName(null);
      this.activeExecution = null;
      unsubscribeRuntime();
    }
  }

  abort(): void {
    this.activeExecution?.abort();
  }

  async dispose(): Promise<void> {
    await this.attachedLease?.release().catch(() => {});
    this.attachedLease = null;
  }

  private assertIdle(): void {
    if (this.turnInProgress) {
      throw new SessionError(
        "SESSION_BUSY",
        "A turn is running. Abort it and wait for cleanup before changing sessions.",
      );
    }
  }

  private assertRunnableSession(session: LoadedSession): void {
    if (!this.agentRegistry.hasGroup(session.activeAgentGroupId)) {
      throw new SessionError("AGENT_GROUP_NOT_FOUND", `Agent Group ${session.activeAgentGroupId} is not configured.`);
    }
    if (!this.agentRegistry.hasAgent(session.activeAgentGroupId, session.activeAgentId)) {
      throw new SessionError(
        "SESSION_AGENT_MISSING",
        `Agent ${session.activeAgentId} is not part of Group ${session.activeAgentGroupId}.`,
      );
    }
    this.agentRegistry.freeze(session.activeAgentGroupId, session.agentModelOverrides);
  }

  private tryResolveActive(): ResolvedModel | null {
    try {
      return (
        this.agentRegistry
          .freeze(this.current.activeAgentGroupId, this.current.agentModelOverrides)
          .agents.get(this.current.activeAgentId)?.resolvedModel ?? null
      );
    } catch {
      return null;
    }
  }

  private async ensureAttached(): Promise<void> {
    if (this.attachedLease || "materialized" in this.current) return;
    this.attachedLease = await this.store.acquire(this.current.id);
  }

  private async attachDraftBeforeMaterialize(): Promise<void> {
    if (this.attachedLease || !("materialized" in this.current)) return;
    this.attachedLease = await this.store.acquire(this.current.id, { create: true });
  }

  private createContextManager(group: FrozenAgentGroup): {
    manager: RuntimeContextManager | undefined;
    sources: ContextSourceMessage[];
  } {
    if (![...group.agents.values()].some((profile) => this.shouldCreateContextManager(profile.resolvedModel)))
      return { manager: undefined, sources: [] };
    const resolved =
      group.agents.get(this.current.activeAgentId)?.resolvedModel ?? [...group.agents.values()][0]?.resolvedModel;
    if (!resolved) return { manager: undefined, sources: [] };
    const summaryModel = this.modelResolver.summaryModel(resolved);
    const sources =
      "materialized" in this.current
        ? []
        : contextSources(this.current.messages, this.current.revision, this.current.compaction.phases);
    const manager = new RuntimeContextManager({
      summarizer: new ModelContextSummarizer(summaryModel.model),
      enabledForModel: (model) => {
        const profile = [...group.agents.values()].find((candidate) => candidate.resolvedModel.model === model);
        return profile ? this.shouldCreateContextManager(profile.resolvedModel) : true;
      },
      summarizerForModel: (model) => {
        const profile = [...group.agents.values()].find((candidate) => candidate.resolvedModel.model === model);
        return new ModelContextSummarizer(
          profile ? this.modelResolver.summaryModel(profile.resolvedModel).model : summaryModel.model,
        );
      },
      restoreState:
        "materialized" in this.current
          ? undefined
          : {
              currentSourceRevision: this.current.revision,
              sources,
              phases: activeContextPhases(this.current.compaction.phases),
              nodes: this.current.compaction.nodes,
              checkpoint: this.current.compaction.checkpoint,
            },
      onStateUpdate: async (update) => {
        if ("materialized" in this.current) return;
        this.current = await this.service.commitCompactionState(this.current.id, update);
      },
    });
    return { manager, sources };
  }

  private shouldCreateContextManager(resolved: ResolvedModel): boolean {
    return (resolved.entry.contextCompactionMode ?? "auto") !== "off";
  }
}

function failedBranchResult(agentId: string, mode: ExecutionMode, error: unknown): ExecutionBranchResult {
  return {
    branchId: "unstarted",
    executionId: "unstarted",
    agentId,
    rootExecutionId: "unstarted",
    initialExecutionId: "unstarted",
    finalExecutionId: "unstarted",
    initialAgentId: agentId,
    finalAgentId: agentId,
    status: "failed",
    mode,
    handoffs: [],
    steps: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageIncomplete: true },
    durationMs: 0,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}

function toMemoryStatusLayer(
  scope: "global" | "project",
  scopeId: string,
  storageRoot: string,
  policy: { access: "none" | "read" | "read_write"; autoWrite: boolean },
  snapshot: {
    materialized: boolean;
    documents: Array<{ reference: string; digest: string; sizeBytes: number; updatedAt: string }>;
    totalBytes: number;
  },
): TerminalMemoryStatus["layers"][number] {
  return {
    scope,
    scopeId,
    access: policy.access,
    autoWrite: policy.autoWrite,
    storageRoot,
    materialized: snapshot.materialized,
    documents: snapshot.documents.map((document) => ({ ...document, digest: shortDigest(document.digest) })),
    totalBytes: snapshot.totalBytes,
  };
}

export function contextSources(
  messages: PersistedSessionMessage[],
  sourceRevision: number,
  phases: PersistedPhase[] = [],
) {
  const turnIndexById = new Map<string, number>();
  const turnIds: string[] = [];
  const phaseByTurnId = new Map<string, Pick<PersistedPhase, "id" | "status">>();
  for (const message of messages) {
    if (!turnIndexById.has(message.turnId)) {
      turnIndexById.set(message.turnId, turnIndexById.size);
      turnIds.push(message.turnId);
    }
  }
  for (const phase of phases) {
    const start = turnIndexById.get(phase.startedTurnId);
    const end = phase.endedTurnId ? turnIndexById.get(phase.endedTurnId) : turnIds.length - 1;
    if (start === undefined || end === undefined) continue;
    for (let turnIndex = start; turnIndex <= end; turnIndex++) {
      const turnId = turnIds[turnIndex];
      if (turnId) phaseByTurnId.set(turnId, phase);
    }
  }
  return messages.map((entry) => {
    const phase = phaseByTurnId.get(entry.turnId);
    return {
      messageId: entry.id,
      turnId: entry.turnId,
      turnIndex: turnIndexById.get(entry.turnId) ?? 0,
      ...(phase ? { phaseId: phase.id, phaseStatus: phase.status } : {}),
      sourceRevision,
    };
  });
}

function appendContextSources(
  current: ContextSourceMessage[],
  messages: PersistedSessionMessage[],
  sourceRevision: number,
  phases: PersistedPhase[],
): ContextSourceMessage[] {
  if (current.length > messages.length) return contextSources(messages, sourceRevision, phases);
  const lastCurrent = current.at(-1);
  const matchingMessage = lastCurrent ? messages[current.length - 1] : undefined;
  if (
    lastCurrent &&
    (matchingMessage?.id !== lastCurrent.messageId || matchingMessage.turnId !== lastCurrent.turnId)
  ) {
    return contextSources(messages, sourceRevision, phases);
  }

  const activePhase = activeContextPhases(phases)[0];
  if (
    lastCurrent &&
    ((activePhase?.id ?? undefined) !== lastCurrent.phaseId ||
      (activePhase?.status ?? undefined) !== lastCurrent.phaseStatus)
  ) {
    return contextSources(messages, sourceRevision, phases);
  }

  let lastTurnId = lastCurrent?.turnId;
  let turnIndex = lastCurrent?.turnIndex ?? -1;
  for (let index = current.length; index < messages.length; index++) {
    const entry = messages[index]!;
    if (entry.turnId !== lastTurnId) {
      lastTurnId = entry.turnId;
      turnIndex++;
    }
    current.push({
      messageId: entry.id,
      turnId: entry.turnId,
      turnIndex,
      ...(activePhase ? { phaseId: activePhase.id, phaseStatus: activePhase.status } : {}),
      sourceRevision,
    });
  }
  return current;
}

function activeContextPhases(phases: PersistedPhase[]): ContextPhaseState[] {
  for (let index = phases.length - 1; index >= 0; index--) {
    const phase = phases[index]!;
    if (phase.status !== "active") continue;
    return [{ id: phase.id, status: phase.status, startedTurnId: phase.startedTurnId }];
  }
  return [];
}

function directoryExists(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
