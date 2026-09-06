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
  type ExecutionBranchResult,
  type HandoffEvent,
} from "@/runtime";
import type { AgentEvent } from "@/runtime/events/agent-event";
import type {
  LoadedSession,
  PersistedTurn,
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
    const lease = await this.store.acquire(this.current.id);
    try {
      await this.store.delete(lease, this.current.id);
    } finally {
      await lease.release().catch(() => {});
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
    const started = await this.service.beginTurn(this.current, {
      id: frozenGroup.id,
      revision: frozenGroup.revision,
    });
    this.current = started.record;
    const turnMode = started.turn.executionMode;
    await this.ensureAttached();
    const userMessage: UserMessage = { role: "user", content: [{ type: "text", text }] };
    this.current = await this.service.appendMessages(this.current.id, started.turn.id, [userMessage]);
    options.onMessage?.(userMessage);
    if (this.shouldCreateContextManager(resolved)) {
      this.current = await this.service.ensureCompactionState(
        this.current.id,
        started.turn.id,
        DEFAULT_CONTEXT_POLICY.policyVersion,
      );
    }
    const contextManager = this.createContextManager(frozenGroup);
    const memoryRuntime = await createTerminalMemoryRuntime({
      cwd: this.current.workspace.cwd,
    });
    const approvalState = { allowedTools: await new SettingsLoader().loadAllowList(this.current.workspace.cwd) };
    let agent: Agent;
    const runtime = new AgentRuntime();
    const modelCalls = new Map<string, { agentId: string; model: string }>();
    let modelPersistence = Promise.resolve();
    const unsubscribeRuntime = runtime.subscribe((event) => {
      if (event.type === "model_call") {
        modelCalls.set(event.executionId, { agentId: event.agentId, model: event.model });
        const profile = frozenGroup.agents.get(event.agentId);
        if (profile) {
          modelPersistence = modelPersistence
            .then(() =>
              this.service.appendEffectiveModel(this.current.id, started.turn.id, {
                executionId: event.executionId,
                agentId: event.agentId,
                ...profile.resolvedModel.effective,
              }),
            )
            .then(() => undefined);
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
      this.current = await this.service.finishTurn(this.current.id, started.turn.id, failed);
      throw error;
    }
    this.activeExecution = agent;

    try {
      agent.setRequestedSkillName(options.requestedSkillName ?? null);
      const run = agent.execute(userMessage, { mode: turnMode });
      for await (const event of run.events) {
        if (event.type === "message") {
          this.current = await this.service.appendMessages(this.current.id, started.turn.id, [event.message]);
          options.onMessage?.(event.message);
        } else if (event.type === "progress") {
          options.onProgress?.(event);
        } else if (event.type === "context") {
          options.onProgress?.(event);
        } else if (event.type === "handoff") {
          if (event.status === "committed") {
            this.current = await this.service.recordHandoff(this.current.id, started.turn.id, event.record);
          }
          options.onHandoff?.(event);
        }
      }
      const result = await run.result;
      await modelPersistence;
      this.current = await this.service.finishTurn(
        this.current.id,
        started.turn.id,
        result,
        effectiveModelsForCalls(modelCalls, frozenGroup),
      );
      const pendingPhase = contextManager?.consumePendingPhaseTransition();
      if (result.status === "completed" && pendingPhase) {
        this.current = await this.service.transitionCompactionPhase(
          this.current.id,
          started.turn.id,
          pendingPhase.objective,
          DEFAULT_CONTEXT_POLICY.policyVersion,
        );
      }
      return result;
    } catch (error) {
      agent.abort();
      await modelPersistence.catch(() => {});
      const failed = failedBranchResult(started.turn.initialAgentId, turnMode, error);
      this.current = await this.service.finishTurn(
        this.current.id,
        started.turn.id,
        failed,
        effectiveModelsForCalls(modelCalls, frozenGroup),
      );
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

  private createContextManager(group: FrozenAgentGroup): RuntimeContextManager | undefined {
    if (![...group.agents.values()].some((profile) => this.shouldCreateContextManager(profile.resolvedModel)))
      return undefined;
    const resolved =
      group.agents.get(this.current.activeAgentId)?.resolvedModel ?? [...group.agents.values()][0]?.resolvedModel;
    if (!resolved) return undefined;
    const summaryModel = this.modelResolver.summaryModel(resolved);
    return new RuntimeContextManager({
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
      initialNodes: "materialized" in this.current ? [] : this.current.compaction.nodes,
      initialFrontierNodeIds: "materialized" in this.current ? [] : this.current.compaction.checkpoint.frontierNodeIds,
      sourceRevision: "materialized" in this.current ? undefined : this.current.revision,
      onCompaction: async (result) => {
        if ("materialized" in this.current) return;
        this.current = await this.service.appendCompactionNodes(this.current.id, {
          nodes: result.nodes,
          frontierNodeIds: result.frontierNodeIds,
          policyVersion: result.policyVersion,
          summarySchemaVersion: result.summarySchemaVersion,
          ...(result.sourceRevision ? { sourceRevision: result.sourceRevision } : {}),
        });
      },
      sources:
        "materialized" in this.current
          ? []
          : contextSources(this.current.messages, this.current.revision, this.current.compaction.phases),
    });
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

function effectiveModelsForCalls(
  calls: ReadonlyMap<string, { agentId: string; model: string }>,
  group: FrozenAgentGroup,
): PersistedTurn["effectiveModels"] {
  const uses: PersistedTurn["effectiveModels"] = [];
  for (const [executionId, call] of calls) {
    const { agentId, model } = call;
    const profile = group.agents.get(agentId);
    if (profile) uses.push({ executionId, agentId, ...profile.resolvedModel.effective, model });
  }
  return uses;
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
  const phaseByTurnId = new Map<string, Pick<PersistedPhase, "id" | "status">>();
  for (const message of messages) {
    if (!turnIndexById.has(message.turnId)) {
      turnIndexById.set(message.turnId, turnIndexById.size);
    }
  }
  for (const phase of phases) {
    const start = turnIndexById.get(phase.startedTurnId);
    const end = phase.endedTurnId ? turnIndexById.get(phase.endedTurnId) : turnIndexById.size - 1;
    if (start === undefined || end === undefined) continue;
    for (const [turnId, turnIndex] of turnIndexById) {
      if (turnIndex >= start && turnIndex <= end) {
        phaseByTurnId.set(turnId, phase);
      }
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

function directoryExists(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}
