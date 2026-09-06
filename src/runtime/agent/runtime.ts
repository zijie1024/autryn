import type { NonSystemMessage, ToolMessage } from "@/core";
import type { ContextManager } from "@/runtime/context";
import { validateMessageBlocks } from "@/runtime/context/message-blocks";
import { normalizeDelegationRequest } from "@/runtime/delegation/delegation";
import { DelegationScheduler } from "@/runtime/delegation/scheduler";
import { AgentExecution, executionError } from "@/runtime/execution/agent-execution";
import { AgentRun } from "@/runtime/execution/agent-run";
import { ExecutionBranch } from "@/runtime/execution/execution-branch";
import {
  DEFAULT_DELEGATION_LIMITS,
  ExecutionCheckpointError,
  type AgentConfiguration,
  type AgentRunOptions,
  type DelegateDefinition,
  type DelegationLimits,
  type DelegationRequest,
  type DelegationResult,
  type DelegationStartResult,
  type DryRunEntry,
  type ExecutionBranchSnapshot,
  type ExecutionCheckpoint,
  type ExecutionCheckpointHandler,
  type ExecutionErrorInfo,
  type ExecutionSnapshot,
  type ExecutionTreeSnapshot,
  type HandoffDefinition,
  type HandoffRecord,
  type RuntimeEventListener,
} from "@/runtime/execution/types";
import { aggregateTree } from "@/runtime/resources/resource-ledger";
import { formatToolResultForMessage } from "@/runtime/tool-results/runtime";
import { DryRunReportBuilder } from "@/runtime/tools/dry-run-report";

import { Agent } from "./agent";

export interface AgentRuntimeOptions {
  limits?: Partial<DelegationLimits>;
  idFactory?: () => string;
  now?: () => number;
  maxRetainedTrees?: number;
  strictToolRegistration?: boolean;
}

type ExecutionRecord = {
  execution: AgentExecution;
  agent: Agent;
  delegates: DelegateDefinition[];
  handoffs: HandoffDefinition[];
  ancestorDelegates: string[];
  children: Set<string>;
};

type StartExecutionOptions = {
  agent: Agent;
  delegates: DelegateDefinition[];
  handoffs?: HandoffDefinition[];
  options?: AgentRunOptions;
  run: (execution: AgentExecution) => Promise<void>;
};

export class AgentRuntime {
  readonly limits: DelegationLimits;
  readonly strictToolRegistration: boolean;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly maxRetainedTrees: number;
  private readonly scheduler: DelegationScheduler;
  private readonly active = new Map<string, ExecutionRecord>();
  private readonly branches = new Map<string, ExecutionBranch>();
  private readonly branchContextManagers = new Map<string, ContextManager>();
  /** One dry-run report per execution tree, keyed by root execution id. */
  private readonly reports = new Map<string, DryRunReportBuilder>();
  private readonly handoffsInProgress = new Set<string>();
  private readonly retainedTrees = new Map<string, ExecutionTreeSnapshot>();
  private readonly retainedTreeOrder: string[] = [];
  private readonly observers = new Set<RuntimeEventListener>();
  private readonly checkpointHandlers = new Map<string, ExecutionCheckpointHandler>();

  constructor(options: AgentRuntimeOptions = {}) {
    this.limits = { ...DEFAULT_DELEGATION_LIMITS, ...(options.limits ?? {}) };
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => Date.now());
    this.maxRetainedTrees = options.maxRetainedTrees ?? 100;
    this.strictToolRegistration = options.strictToolRegistration ?? false;
    this.scheduler = new DelegationScheduler(this.limits);
  }

  startRoot(options: StartExecutionOptions): AgentRun {
    const id = this.idFactory();
    const branchId = id;
    const mode = options.options?.mode ?? "execute";
    if (mode === "dry_run") {
      this.reports.set(id, new DryRunReportBuilder(branchId, id));
    }
    const execution = this.createExecution({
      id,
      branchId,
      rootExecutionId: id,
      depth: 0,
      agent: options.agent,
      delegates: options.delegates,
      handoffs: options.handoffs ?? [],
      ancestorDelegates: [],
      mode,
    });
    const branch = new ExecutionBranch({
      id: branchId,
      rootExecutionId: id,
      initialExecution: execution,
      now: this.now,
      dryRunReport: (status) => {
        const report = this.reports.get(id);
        report?.finish(status);
        const snapshot = report?.snapshot();
        this.reports.delete(id);
        return snapshot;
      },
    });
    this.branches.set(branchId, branch);
    if (options.options?.onCheckpoint) {
      this.checkpointHandlers.set(id, options.options.onCheckpoint);
    }
    if (options.agent.contextManager) this.branchContextManagers.set(branchId, options.agent.contextManager);
    const run = new AgentRun(branch, execution);
    queueMicrotask(() => {
      if (execution.terminal) return;
      execution.startRunning();
      void options.run(execution);
    });
    return run;
  }

  async checkpoint(
    execution: AgentExecution,
    input: Pick<ExecutionCheckpoint, "reason" | "messages" | "handoff">,
  ): Promise<void> {
    const handler = this.checkpointHandlers.get(execution.rootExecutionId);
    if (!handler) return;
    try {
      await handler({
        reason: input.reason,
        executionId: execution.id,
        rootExecutionId: execution.rootExecutionId,
        branchId: execution.branchId,
        agentId: execution.agentId,
        step: execution.getSnapshot().steps,
        messages: input.messages,
        ...(input.handoff ? { handoff: input.handoff } : {}),
      });
    } catch (error) {
      if (error instanceof ExecutionCheckpointError) throw error;
      throw new ExecutionCheckpointError(error);
    }
  }

  startDelegation(parent: AgentExecution, request: DelegationRequest): DelegationStartResult {
    const normalized = normalizeDelegationRequest(request);
    if ("ok" in normalized) {
      return { accepted: false, error: executionError("INVALID_DELEGATION_REQUEST", normalized.error) };
    }

    const preflight = this.preflight(parent, normalized);
    if (!preflight.ok) {
      return { accepted: false, error: preflight.error };
    }

    const id = this.idFactory();
    const branchId = id;
    const timeoutMs = Math.min(
      normalized.timeoutMs ?? preflight.definition.policy?.timeoutMs ?? this.limits.childTimeoutMs,
      preflight.definition.policy?.timeoutMs ?? this.limits.childTimeoutMs,
    );

    const execution = this.createExecution({
      id,
      branchId,
      parentExecutionId: parent.id,
      rootExecutionId: parent.rootExecutionId,
      depth: parent.depth + 1,
      agent: preflight.parentRecord.agent,
      agentId: preflight.definition.name,
      agentName: preflight.definition.name,
      delegates: [],
      handoffs: [],
      delegateName: preflight.definition.name,
      metadata: normalized.metadata,
      timeoutMs,
      ancestorDelegates: [...preflight.parentRecord.ancestorDelegates, preflight.definition.name],
      mode: parent.mode,
    });
    const branch = new ExecutionBranch({
      id: branchId,
      rootExecutionId: parent.rootExecutionId,
      parentBranchId: parent.branchId,
      initialExecution: execution,
      now: this.now,
      dryRunReport: () => this.reports.get(parent.rootExecutionId)?.snapshot(),
    });
    this.branches.set(branchId, branch);
    preflight.parentRecord.children.add(execution.id);

    const start = () => {
      void this.buildAndRunChild({ parent, execution, definition: preflight.definition, task: normalized.task });
    };
    this.scheduler.schedule({
      execution,
      parentExecutionId: parent.id,
      rootExecutionId: parent.rootExecutionId,
      start,
    });

    return { accepted: true, branch: branch.getSnapshot(), execution };
  }

  async delegate(
    parent: AgentExecution,
    request: DelegationRequest,
    signal?: AbortSignal,
    options: { beforeWait?: Promise<void> } = {},
  ): Promise<DelegationResult> {
    const started = this.startDelegation(parent, request);
    if (!started.accepted) return started;
    const suspended = await this.suspendForChildWait(parent, options.beforeWait, signal);
    try {
      const branch = this.branches.get(started.execution.branchId);
      const result = await raceWithAbort(
        branch ? branch.result : started.execution.result.then((execution) => execution as never),
        signal,
      );
      return { accepted: true, execution: result };
    } finally {
      await this.resumeAfterChildWait(parent, suspended, signal);
    }
  }

  getExecution(id: string): ExecutionSnapshot | undefined {
    return this.active.get(id)?.execution.getSnapshot();
  }

  getTree(rootExecutionId: string): ExecutionTreeSnapshot | undefined {
    const retained = this.retainedTrees.get(rootExecutionId);
    if (retained) return structuredClone(retained);
    const executions = [...this.active.values()]
      .filter((record) => record.execution.rootExecutionId === rootExecutionId)
      .map((record) => record.execution.getSnapshot());
    if (executions.length === 0) return undefined;
    return aggregateTree(
      rootExecutionId,
      executions,
      [...this.branches.values()]
        .filter((branch) => branch.rootExecutionId === rootExecutionId)
        .map((branch) => branch.getSnapshot()),
    );
  }

  getBranch(id: string): ExecutionBranchSnapshot | undefined {
    return this.branches.get(id)?.getSnapshot();
  }

  getBranchMessages(id: string) {
    return this.branches.get(id)?.getMessagesSnapshot() ?? [];
  }

  getDelegates(execution: AgentExecution): DelegateDefinition[] {
    return this.active.get(execution.id)?.delegates ?? [];
  }

  getHandoffs(execution: AgentExecution): HandoffDefinition[] {
    return this.active.get(execution.id)?.handoffs ?? [];
  }

  recordDryRunEntry(entry: DryRunEntry) {
    const rootExecutionId = this.active.get(entry.executionId)?.execution.rootExecutionId;
    if (rootExecutionId) this.reports.get(rootExecutionId)?.add(entry);
  }

  cancelExecution(executionId: string, reason = "Execution cancelled."): boolean {
    const execution = this.active.get(executionId)?.execution;
    if (!execution || execution.terminal) return false;
    execution.cancel(reason);
    return true;
  }

  private async suspendForChildWait(
    parent: AgentExecution,
    beforeWait?: Promise<void>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    await raceWithAbort(beforeWait ?? Promise.resolve(), signal);
    if (!parent.parentExecutionId || parent.terminal) return false;
    parent.setWaitingForChildren();
    this.scheduler.release(parent);
    return true;
  }

  private async resumeAfterChildWait(parent: AgentExecution, suspended: boolean, signal?: AbortSignal): Promise<void> {
    if (!suspended || parent.terminal) return;
    const reacquired = await raceWithAbort(this.scheduler.reacquire(parent), signal);
    if (reacquired) {
      parent.setActive();
    }
  }

  isTreeTokenLimitExceeded(execution: AgentExecution): boolean {
    const tree = this.getTree(execution.rootExecutionId);
    return (tree?.usage.totalTokens ?? 0) >= this.limits.maxTokensPerTree;
  }

  isBranchStepLimitExceeded(execution: AgentExecution): boolean {
    const branch = this.branches.get(execution.branchId);
    return (branch?.getStepCount() ?? execution.getSnapshot().steps) > this.limits.maxStepsPerBranch;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.observers.add(listener);
    return () => {
      this.observers.delete(listener);
    };
  }

  recordModelCall(execution: AgentExecution, model: string): void {
    const event = {
      type: "model_call" as const,
      executionId: execution.id,
      rootExecutionId: execution.rootExecutionId,
      branchId: execution.branchId,
      agentId: execution.agentId,
      model,
      timestamp: this.now(),
    };
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        // Observers are observational and cannot affect execution.
      }
    }
  }

  cancelDescendants(execution: AgentExecution, reason = "Parent execution ended.") {
    const record = this.active.get(execution.id);
    if (!record) return;
    for (const childId of record.children) {
      const child = this.active.get(childId)?.execution;
      if (child && !child.terminal) {
        child.cancel(reason);
      }
    }
  }

  private createExecution(options: {
    id: string;
    branchId: string;
    parentExecutionId?: string;
    rootExecutionId: string;
    depth: number;
    agent: Agent;
    agentId?: string;
    agentName?: string;
    delegates: DelegateDefinition[];
    handoffs: HandoffDefinition[];
    delegateName?: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
    deadlineAt?: number;
    ancestorDelegates: string[];
    predecessorExecutionId?: string;
    handoffIndex?: number;
    mode: "execute" | "dry_run";
  }) {
    const execution = new AgentExecution({
      id: options.id,
      ...(options.parentExecutionId ? { parentExecutionId: options.parentExecutionId } : {}),
      rootExecutionId: options.rootExecutionId,
      branchId: options.branchId,
      agentId: options.agentId ?? options.agent.id,
      agentName: options.agentName ?? options.agent.name,
      ...(options.delegateName ? { delegateName: options.delegateName } : {}),
      depth: options.depth,
      handoffIndex: options.handoffIndex ?? 0,
      predecessorExecutionId: options.predecessorExecutionId,
      mode: options.mode,
      now: this.now,
      metadata: options.metadata,
      timeoutMs: options.timeoutMs,
      deadlineAt: options.deadlineAt,
      onStatus: (current) => this.publish(current),
      onTerminal: (current) => this.onTerminal(current),
    });
    this.active.set(execution.id, {
      execution,
      agent: options.agent,
      delegates: options.delegates,
      handoffs: options.handoffs,
      ancestorDelegates: options.ancestorDelegates,
      children: new Set(),
    });
    return execution;
  }

  private async buildAndRunChild({
    parent,
    execution,
    definition,
    task,
  }: {
    parent: AgentExecution;
    execution: AgentExecution;
    definition: DelegateDefinition;
    task: string;
  }) {
    try {
      const parentRecord = this.active.get(parent.id);
      if (!parentRecord) {
        execution.fail(executionError("INTERNAL_ERROR", "Parent execution is no longer active."));
        return;
      }
      const config = await definition.create({
        runtime: this,
        parent: parent.getSnapshot(),
        parentModel: parentRecord.agent.model,
        task,
      });
      const childConfig = this.applyPolicy(config, parentRecord, definition);
      const child = new Agent({ ...childConfig, runtime: this });
      const childRecord = this.active.get(execution.id);
      if (childRecord) {
        childRecord.agent = child;
        childRecord.delegates = childConfig.delegates ?? [];
        childRecord.handoffs = childConfig.handoffs ?? [];
      }
      if (child.contextManager) this.branchContextManagers.set(execution.branchId, child.contextManager);
      await child.runExecution(execution, { role: "user", content: [{ type: "text", text: task }] });
    } catch {
      execution.fail(executionError("DELEGATE_FACTORY_FAILED", `Delegate ${definition.name} failed to initialize.`));
    }
  }

  private applyPolicy(
    config: AgentConfiguration,
    parentRecord: ExecutionRecord,
    definition: DelegateDefinition,
  ): AgentConfiguration {
    const policy = definition.policy;
    const tools = policy?.tools ? applyToolPolicy(policy.tools, parentRecord.agent.tools ?? [], config.tools ?? []) : [];
    const skills = policy?.skills ? applySkillPolicy(policy.skills, parentRecord.agent.skills ?? []) : [];
    const delegates = policy?.delegates ?? config.delegates ?? [];
    return {
      ...config,
      model: policy?.model ?? config.model,
      tools,
      skills,
      delegates,
      handoffs: config.handoffs ?? [],
      maxSteps: policy?.maxSteps ?? config.maxSteps ?? this.limits.childMaxSteps,
      messages: [],
      contextManager: config.contextManager,
    };
  }

  private preflight(
    parent: AgentExecution,
    request: DelegationRequest,
  ):
    | { ok: true; definition: DelegateDefinition; parentRecord: ExecutionRecord }
    | { ok: false; error: ExecutionErrorInfo } {
    const parentRecord = this.active.get(parent.id);
    if (!parentRecord || parent.terminal) {
      return {
        ok: false,
        error: executionError("DELEGATION_NOT_ALLOWED", "Parent execution cannot delegate from its current state."),
      };
    }
    const definition = parentRecord.delegates.find((candidate) => candidate.name === request.delegate);
    if (!definition) {
      return {
        ok: false,
        error: executionError("DELEGATE_NOT_FOUND", `Delegate ${request.delegate} is not registered.`),
      };
    }
    if (parent.depth >= this.limits.maxDepth) {
      return { ok: false, error: executionError("DEPTH_LIMIT_EXCEEDED", "Delegation depth limit exceeded.") };
    }
    if (parentRecord.children.size >= this.limits.maxChildrenPerExecution) {
      return { ok: false, error: executionError("CHILD_LIMIT_EXCEEDED", "Child execution limit exceeded.") };
    }
    const treeCount = [...this.active.values()].filter(
      (record) => record.execution.rootExecutionId === parent.rootExecutionId,
    ).length;
    if (treeCount >= this.limits.maxExecutionsPerTree) {
      return { ok: false, error: executionError("TREE_LIMIT_EXCEEDED", "Execution tree limit exceeded.") };
    }
    if (this.isTreeTokenLimitExceeded(parent)) {
      return { ok: false, error: executionError("TOKEN_LIMIT_EXCEEDED", "Execution tree token limit exceeded.") };
    }
    if (parentRecord.ancestorDelegates.includes(definition.name)) {
      return {
        ok: false,
        error: executionError("RECURSION_NOT_ALLOWED", `Recursive delegation to ${definition.name} is not allowed.`),
      };
    }
    return { ok: true, definition, parentRecord };
  }

  private onTerminal(execution: AgentExecution) {
    this.scheduler.cancelQueued(execution);
    this.scheduler.release(execution);
    this.cancelDescendants(execution);
    this.publish(execution);
    if (execution.status === "handed_off") {
      return;
    }
    if (execution.parentExecutionId) {
      return;
    }
    const tree = this.getTree(execution.rootExecutionId);
    if (tree) {
      this.retainedTrees.set(execution.rootExecutionId, tree);
      this.retainedTreeOrder.push(execution.rootExecutionId);
      while (this.retainedTreeOrder.length > this.maxRetainedTrees) {
        const oldest = this.retainedTreeOrder.shift();
        if (oldest) this.retainedTrees.delete(oldest);
      }
    }
    for (const record of [...this.active.values()]) {
      if (record.execution.rootExecutionId === execution.rootExecutionId && record.execution.terminal) {
        this.active.delete(record.execution.id);
      }
    }
    for (const [branchId, branch] of this.branches) {
      if (branch.rootExecutionId === execution.rootExecutionId) this.branchContextManagers.delete(branchId);
    }
    this.checkpointHandlers.delete(execution.rootExecutionId);
  }

  async handoff<I extends Record<string, unknown>>(
    source: AgentExecution,
    options: { target: string; input: I; toolUseId?: string },
  ) {
    source.emitHandoffEvent({
      type: "handoff",
      status: "requested",
      sourceExecutionId: source.id,
      targetAgentId: options.target,
    });

    if (this.handoffsInProgress.has(source.id)) {
      return this.rejectHandoff(source, options.target, "HANDOFF_NOT_ALLOWED", "A handoff is already in progress.");
    }
    this.handoffsInProgress.add(source.id);
    try {
      return await this.performHandoff(source, options);
    } finally {
      this.handoffsInProgress.delete(source.id);
    }
  }

  private async performHandoff<I extends Record<string, unknown>>(
    source: AgentExecution,
    options: { target: string; input: I; toolUseId?: string },
  ) {
    const branch = this.branches.get(source.branchId);
    const sourceRecord = this.active.get(source.id);
    if (!branch || !sourceRecord || source.terminal || branch.current().id !== source.id) {
      return this.rejectHandoff(source, options.target, "HANDOFF_NOT_ALLOWED", "Source execution cannot hand off now.");
    }
    const definition = sourceRecord.handoffs.find((candidate) => candidate.target === options.target);
    if (!definition) {
      return this.rejectHandoff(
        source,
        options.target,
        "HANDOFF_TARGET_NOT_FOUND",
        `Handoff target ${options.target} is not registered.`,
      );
    }
    if (branch.getSnapshot().handoffCount >= this.limits.maxHandoffsPerBranch) {
      return this.rejectHandoff(source, options.target, "HANDOFF_LIMIT_EXCEEDED", "Handoff limit exceeded.");
    }
    const visits = branch.getSnapshot().handoffs.filter((record) => record.targetAgentId === options.target).length;
    if (visits >= this.limits.maxVisitsPerTargetPerBranch) {
      return this.rejectHandoff(
        source,
        options.target,
        "HANDOFF_TARGET_VISIT_LIMIT_EXCEEDED",
        "Handoff target visit limit exceeded.",
      );
    }
    const treeCount = [...this.active.values()].filter(
      (record) => record.execution.rootExecutionId === source.rootExecutionId,
    ).length;
    if (treeCount >= this.limits.maxExecutionsPerTree) {
      return this.rejectHandoff(source, options.target, "TREE_LIMIT_EXCEEDED", "Execution tree limit exceeded.");
    }
    if (this.isTreeTokenLimitExceeded(source)) {
      return this.rejectHandoff(source, options.target, "TOKEN_LIMIT_EXCEEDED", "Execution tree token limit exceeded.");
    }

    let parsed = definition.input.safeParse(options.input);
    if (!parsed.success) {
      return this.rejectHandoff(source, options.target, "HANDOFF_INPUT_INVALID", "Handoff input is invalid.");
    }
    const control = await sourceRecord.agent.beforeHandoff({
      source: source.getSnapshot(),
      branch: branch.getSnapshot(),
      targetAgentId: definition.target,
      input: parsed.data,
    });
    if (control?.action === "reject") {
      return this.rejectHandoff(
        source,
        options.target,
        control.result.code ?? "HANDOFF_NOT_ALLOWED",
        control.result.error,
      );
    }
    if (control?.action === "continue" && control.input) {
      parsed = definition.input.safeParse(control.input);
      if (!parsed.success) {
        return this.rejectHandoff(
          source,
          options.target,
          "HANDOFF_INPUT_INVALID",
          "Handoff middleware input is invalid.",
        );
      }
    }

    let config: AgentConfiguration;
    try {
      config = await definition.create({
        runtime: this,
        source: source.getSnapshot(),
        branch: branch.getSnapshot(),
        input: parsed.data,
        model: sourceRecord.agent.model,
      });
    } catch {
      return this.rejectHandoff(
        source,
        options.target,
        "HANDOFF_TARGET_FACTORY_FAILED",
        `Handoff target ${options.target} failed to initialize.`,
      );
    }
    const targetAgentId = config.id ?? config.name ?? definition.target;
    if (targetAgentId !== definition.target) {
      return this.rejectHandoff(
        source,
        options.target,
        "HANDOFF_TARGET_MISMATCH",
        "Handoff target factory returned a different agent id.",
      );
    }
    const id = this.idFactory();
    const result = {
      ok: true,
      summary: `Handed off to ${definition.target}.`,
      data: {
        targetAgentId: definition.target,
        successorExecutionId: id,
        sequence: branch.getSnapshot().handoffCount + 1,
      },
    };
    const confirmationMessage: ToolMessage | null = options.toolUseId
      ? {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: options.toolUseId,
              content: formatToolResultForMessage({ toolName: handoffToolName(definition.target), result }),
            },
          ],
        }
      : null;
    const canonicalMessages = branch.getMessagesSnapshot();
    let messages = confirmationMessage ? [...canonicalMessages, confirmationMessage] : [...canonicalMessages];
    try {
      if (definition.context?.mode === "filter") {
        messages = await definition.context.filter({
          source: source.getSnapshot(),
          branch: branch.getSnapshot(),
          messages,
        });
      }
      validateHandoffContext(messages, canonicalMessages, options.toolUseId);
    } catch {
      return this.rejectHandoff(source, options.target, "HANDOFF_CONTEXT_INVALID", "Handoff context is invalid.");
    }

    let successor: Agent;
    try {
      successor = new Agent({
        ...config,
        id: definition.target,
        messages,
        contextManager: this.branchContextManagers.get(source.branchId) ?? config.contextManager,
        runtime: this,
      });
    } catch {
      return this.rejectHandoff(
        source,
        options.target,
        "HANDOFF_TARGET_FACTORY_FAILED",
        `Handoff target ${options.target} failed to initialize.`,
      );
    }
    if (source.terminal || branch.current().id !== source.id) {
      return this.rejectHandoff(source, options.target, "HANDOFF_NOT_ALLOWED", "Source execution cannot hand off now.");
    }
    const currentTreeCount = [...this.active.values()].filter(
      (record) => record.execution.rootExecutionId === source.rootExecutionId,
    ).length;
    if (currentTreeCount >= this.limits.maxExecutionsPerTree) {
      return this.rejectHandoff(source, options.target, "TREE_LIMIT_EXCEEDED", "Execution tree limit exceeded.");
    }
    if (this.isTreeTokenLimitExceeded(source)) {
      return this.rejectHandoff(source, options.target, "TOKEN_LIMIT_EXCEEDED", "Execution tree token limit exceeded.");
    }
    const record: HandoffRecord = {
      sourceExecutionId: source.id,
      successorExecutionId: id,
      sourceAgentId: source.agentId,
      targetAgentId: definition.target,
      sequence: result.data.sequence,
      committedAt: this.now(),
    };
    await this.checkpoint(source, {
      reason: "handoff_committed",
      messages: confirmationMessage ? [confirmationMessage] : [],
      handoff: record,
    });
    const successorExecution = this.createExecution({
      id,
      branchId: source.branchId,
      parentExecutionId: source.parentExecutionId,
      rootExecutionId: source.rootExecutionId,
      depth: source.depth,
      agent: successor,
      delegates: config.delegates ?? [],
      handoffs: config.handoffs ?? [],
      ancestorDelegates: sourceRecord.ancestorDelegates,
      predecessorExecutionId: source.id,
      handoffIndex: source.handoffIndex + 1,
      mode: source.mode,
      deadlineAt: source.deadlineAt,
    });
    if (confirmationMessage) {
      source.appendMessage(confirmationMessage);
      source.emitAgentEvent({ type: "message", message: confirmationMessage });
    }
    source.emitHandoffEvent({
      type: "handoff",
      status: "committed",
      sourceExecutionId: source.id,
      successorExecutionId: successorExecution.id,
      targetAgentId: definition.target,
      record,
    });
    branch.commitHandoff(record, successorExecution);
    queueMicrotask(() => {
      if (successorExecution.terminal) return;
      successorExecution.startRunning();
      void successor.runExecution(successorExecution);
    });
    try {
      await sourceRecord.agent.afterHandoff({
        record,
        source: source.getSnapshot(),
        branch: branch.getSnapshot(),
      });
    } catch {
      // 控制权已经转移，afterHandoff 仅用于观察，不能阻断 successor。
    }
    return result;
  }

  private rejectHandoff(source: AgentExecution, target: string, code: string, message: string) {
    const error = executionError(code as never, message, true);
    source.emitHandoffEvent({
      type: "handoff",
      status: "rejected",
      sourceExecutionId: source.id,
      targetAgentId: target,
      error,
    });
    return { ok: false, summary: message, error: message, code };
  }

  private publish(execution: AgentExecution) {
    const event = { type: "execution" as const, execution: execution.getSnapshot() };
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        // Observers 是诊断侧信道，绝不能影响执行结果。
      }
    }
  }
}

function handoffToolName(target: string) {
  return `handoff_to_${target.replaceAll("-", "_")}`;
}

function validateHandoffContext(
  messages: readonly NonSystemMessage[],
  canonicalMessages: readonly NonSystemMessage[],
  toolUseId?: string,
): void {
  validateMessageBlocks(messages);

  const currentUserMessage = findLastMessage(canonicalMessages, "user");
  if (currentUserMessage && !messages.some((message) => messageEquals(message, currentUserMessage))) {
    throw new Error("Handoff context removed the current user task.");
  }
  if (!toolUseId) return;

  const hasToolUse = messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some((content) => content.type === "tool_use" && content.id === toolUseId),
  );
  const hasToolResult = messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some((content) => content.type === "tool_result" && content.tool_use_id === toolUseId),
  );
  if (!hasToolUse || !hasToolResult) {
    throw new Error("Handoff context removed the transfer request or confirmation.");
  }
}

function findLastMessage(messages: readonly NonSystemMessage[], role: NonSystemMessage["role"]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) return messages[index];
  }
  return undefined;
}

function messageEquals(left: NonSystemMessage, right: NonSystemMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyToolPolicy(
  policy: NonNullable<DelegateDefinition["policy"]>["tools"],
  parentTools: Agent["tools"],
  configuredTools: Agent["tools"],
) {
  if (!policy || policy.mode === "none") return [];
  if (policy.mode === "configured") return assertUniqueTools(configuredTools ?? []);
  if (policy.mode === "explicit") return assertUniqueTools(policy.tools);
  const allow = policy.allow ? new Set(policy.allow) : null;
  const deny = new Set(policy.deny ?? []);
  return assertUniqueTools(
    (parentTools ?? []).filter((tool) => !deny.has(tool.name) && (!allow || allow.has(tool.name))),
  );
}

function assertUniqueTools<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
  }
  return [...tools];
}

function applySkillPolicy(
  policy: NonNullable<DelegateDefinition["policy"]>["skills"],
  parentSkills: NonNullable<Agent["skills"]>,
) {
  if (!policy || policy.mode === "none") return [];
  if (policy.mode === "explicit") return [...policy.skills];
  const allow = new Set(policy.allow ?? []);
  if (allow.size === 0) return [...parentSkills];
  return parentSkills.filter((skill) => allow.has(skill.name));
}

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}
