import type { z } from "zod";

import type {
  AssistantMessage,
  Model,
  ModelContext,
  NonSystemMessage,
  StructuredToolError,
  Tool,
  ToolMessage,
  ToolUseContent,
  UserMessage,
} from "@/core";
import { AgentRuntime } from "@/runtime/agent/runtime";
import { ContextError, type ContextManager } from "@/runtime/context";
import { createDelegateTaskTool } from "@/runtime/delegation/delegation";
import type { AgentEvent } from "@/runtime/events/agent-event";
import {
  type AgentExecution,
  executionError,
  sanitizeAssistantMessage,
  textFromAssistant,
} from "@/runtime/execution/agent-execution";
import type { AgentRun } from "@/runtime/execution/agent-run";
import {
  type AgentId,
  type AgentRunOptions,
  type DelegateDefinition,
  ExecutionCheckpointError,
  type ExecutionBranchResult,
  type ExecutionResult,
  type HandoffDefinition,
} from "@/runtime/execution/types";
import type {
  AfterHandoffParams,
  AgentMiddleware,
  BeforeHandoffParams,
  BeforeHandoffResult,
} from "@/runtime/middleware/agent-middleware";
import { formatToolResultForMessage } from "@/runtime/tool-results/runtime";
import { ToolExecutor } from "@/runtime/tools/tool-executor";

import type { SkillFrontmatter } from "../skills/types";

/**
 * 用于调用 ReAct agent 的上下文。
 */
export interface AgentContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  skills?: SkillFrontmatter[];
  /** 调用方显式请求的下一次运行所用 skill 名称（若设置了）。 */
  requestedSkillName?: string | null;
}

/** Agent 运行选项。 */
export interface AgentOptions {
  maxSteps?: number;
}

export type AgentConstructorOptions = {
  id?: AgentId;
  name?: string;
  model: Model;
  prompt: string;
  messages?: NonSystemMessage[];
  tools?: Tool[];
  skills?: SkillFrontmatter[];
  middlewares?: AgentMiddleware[];
  maxSteps?: number;
  runtime?: AgentRuntime;
  delegates?: DelegateDefinition[];
  handoffs?: HandoffDefinition[];
  contextManager?: ContextManager;
};

/**
 * 使用 ReAct 模式推理并执行动作的 agent loop。
 */
export class Agent {
  private readonly _context: AgentContext;
  private _streaming = false;
  private _activeExecution: AgentExecution | null = null;
  private _activeRun: AgentRun | null = null;
  private readonly _runtime: AgentRuntime;
  private readonly _delegates: DelegateDefinition[];
  private readonly _handoffs: HandoffDefinition[];

  readonly id: AgentId;
  readonly name?: string;
  readonly model: Model;
  readonly options: Required<AgentOptions>;
  readonly middlewares: AgentMiddleware[];
  readonly contextManager?: ContextManager;

  constructor({
    id,
    name,
    model,
    prompt,
    messages = [],
    tools,
    skills,
    middlewares = [],
    maxSteps = 100,
    runtime,
    delegates = [],
    handoffs = [],
    contextManager,
  }: AgentConstructorOptions) {
    this.id = id ?? name ?? "agent";
    this.name = name;
    validateAgentId(this.id);
    this.model = model;
    this._runtime = runtime ?? new AgentRuntime();
    validateTools(tools, this._runtime.strictToolRegistration);
    validateHandoffs({ agentId: this.id, tools, delegates, handoffs });
    this._delegates = delegates;
    this._handoffs = handoffs;
    this._context = {
      prompt,
      tools,
      messages,
      skills,
    };
    this.middlewares = middlewares;
    this.contextManager = contextManager;
    this.options = { maxSteps };
  }

  get messages() {
    return this._context.messages;
  }

  get prompt() {
    return this._context.prompt;
  }
  set prompt(prompt: string) {
    this._context.prompt = prompt;
  }

  get tools() {
    return this._context.tools;
  }

  get skills() {
    return this._context.skills;
  }

  setRequestedSkillName(requestedSkillName: string | null) {
    this._context.requestedSkillName = requestedSkillName;
  }

  get streaming() {
    return this._streaming;
  }

  clearMessages() {
    this._context.messages.length = 0;
  }

  /** 运行 agent，返回执行句柄；达到最大 step 数时执行以 limit 状态结束。 */
  execute(message: UserMessage, options: AgentRunOptions = {}): AgentRun {
    if (this._streaming) {
      throw new Error("Agent is already streaming");
    }
    const run = this._runtime.startRoot({
      agent: this,
      delegates: this._delegates,
      handoffs: this._handoffs,
      options,
      run: (current) => this.runExecution(current, message),
    });
    this._activeRun = run;
    this._activeExecution = null;
    this._streaming = true;
    void run.result.finally(() => {
      if (this._activeRun === run) {
        this._activeRun = null;
        this._streaming = false;
      }
    });
    return run;
  }

  async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
    const run = this.execute(message);
    for await (const event of run.events) {
      if (event.type === "message") {
        yield { type: "message", message: event.message };
      } else if (event.type === "progress") {
        if (event.subtype === "thinking") {
          yield { type: "progress", subtype: "thinking" };
        } else {
          yield { type: "progress", subtype: "tool", name: event.name, input: event.input };
        }
      }
    }
    const result = await run.result;
    if (result.status !== "completed") {
      throw errorForStream(result);
    }
  }

  async runExecution(execution: AgentExecution, message?: UserMessage): Promise<void> {
    this._activeExecution = execution;
    if (message) {
      this._appendMessage(message);
      execution.appendMessage(message);
    }
    const forbiddenMiddleware = this._findForbiddenDryRunMiddleware(execution);
    if (forbiddenMiddleware) {
      execution.fail(
        executionError(
          "MIDDLEWARE_FAILED",
          `Middleware ${forbiddenMiddleware.name ?? "(anonymous)"} is not compatible with dry-run: ${forbiddenMiddleware.dryRun.mode === "forbidden" ? forbiddenMiddleware.dryRun.reason : "forbidden"}.`,
        ),
      );
      return;
    }
    await this._beforeAgentRun();
    try {
      for (let step = 1; step <= this.options.maxSteps; step++) {
        execution.signal.throwIfAborted();
        execution.noteStep();
        if (this._runtime.isBranchStepLimitExceeded(execution)) {
          execution.limit(executionError("MAX_STEPS_EXCEEDED", "Execution branch step limit exceeded."));
          return;
        }
        await this._beforeAgentStep(step);
        const assistantMessage = await this._think(execution);
        await this._afterModel(assistantMessage);
        execution.emitAgentEvent({ type: "message", message: assistantMessage });
        if (this._runtime.isTreeTokenLimitExceeded(execution)) {
          execution.limit(executionError("TOKEN_LIMIT_EXCEEDED", "Execution tree token limit exceeded."));
          return;
        }

        const toolUses = this._extractToolUses(assistantMessage);
        if (toolUses.length === 0) {
          await this._afterAgentRun();
          execution.complete({
            text: textFromAssistant(assistantMessage),
            message: sanitizeAssistantMessage(assistantMessage),
          });
          return;
        }

        await this._runtime.checkpoint(execution, { reason: "tool_call", messages: [assistantMessage] });
        const toolMessages = await this._act(execution, toolUses);
        if (execution.status === "handed_off") return;
        await this._afterAgentStep(step);
        await this._runtime.checkpoint(execution, { reason: "step_completed", messages: toolMessages });
      }
      execution.limit(executionError("MAX_STEPS_EXCEEDED", "Maximum number of steps reached"));
    } catch (error) {
      if (execution.terminal) return;
      if (execution.signal.aborted) {
        execution.cancel("Execution cancelled.");
        return;
      }
      const messageText = error instanceof Error ? error.message : String(error);
      execution.fail(
        executionError(error instanceof ExecutionCheckpointError ? "CHECKPOINT_FAILED" : "MODEL_FAILED", messageText),
      );
    }
  }

  /** 中止当前流，包括正在进行的 model 请求。 */
  abort() {
    this._activeRun?.cancel("Execution cancelled.");
  }

  async beforeHandoff(params: Omit<BeforeHandoffParams, "agentContext">): Promise<BeforeHandoffResult> {
    let input = params.input;
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, params.source.mode)) continue;
      if (!middleware.beforeHandoff) continue;
      const result = await middleware.beforeHandoff({
        ...params,
        input,
        agentContext: this._context,
      });
      if (!result) continue;
      if (result.action === "reject") return result;
      if (result.input) input = result.input;
    }
    return input === params.input ? undefined : { action: "continue", input };
  }

  async afterHandoff(params: Omit<AfterHandoffParams, "agentContext">): Promise<void> {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, params.source.mode)) continue;
      if (!middleware.afterHandoff) continue;
      try {
        await middleware.afterHandoff({ ...params, agentContext: this._context });
      } catch {
        // Handoff 已提交，观察型 middleware 不应回滚控制权转移。
      }
    }
  }

  private async _think(execution: AgentExecution): Promise<AssistantMessage> {
    const modelContext: ModelContext = {
      prompt: this.prompt,
      messages: this.messages,
      tools: this._effectiveTools(execution),
      signal: execution.signal,
    };
    await this._beforeModel(modelContext);
    if (execution.mode === "dry_run") {
      modelContext.prompt +=
        "\n\n<runtime_mode>dry-run: mutation tools return previews instead of changing persistent state. Distinguish read facts, planned changes, and blocked operations.</runtime_mode>";
    }
    await this._prepareContext(execution, modelContext);
    if (execution.terminal) {
      throw new Error("Execution already ended.");
    }

    this._runtime.recordModelCall(execution, this.model.name);
    let latest: AssistantMessage | null = null;
    for await (const snapshot of this.model.stream(modelContext)) {
      latest = snapshot;
      if (snapshot.streaming) {
        execution.emitAgentEvent(this._deriveProgress(snapshot));
      }
    }
    if (!latest) {
      throw new Error("Model stream ended without producing a message");
    }
    if (execution.terminal) {
      execution.signal.throwIfAborted();
      throw new Error("Execution already ended.");
    }
    // 防御性处理：确保最终消息不再标记为流式。
    if (latest.streaming) {
      delete latest.streaming;
    }
    execution.noteUsage(latest);
    this._appendMessage(latest);
    execution.appendMessage(latest);
    return latest;
  }

  private _deriveProgress(snapshot: AssistantMessage): AgentEvent {
    const toolUses = snapshot.content.filter((c): c is ToolUseContent => c.type === "tool_use");
    if (toolUses.length === 0) {
      return { type: "progress", subtype: "thinking" };
    }
    const last = toolUses[toolUses.length - 1]!;
    return { type: "progress", subtype: "tool", name: last.name, input: last.input };
  }

  private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
    return message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
  }

  /**
   * 调用前用 tool 的 Zod schema 校验 model 提供的输入。
   * 校验通过返回解析（含转换）后的输入；失败返回结构化错误并报告给 model，不调用 tool。
   * 对 `parameters` 不暴露 `safeParse` 的 tool（部分库消费者传入的鸭子类型 tool 对象）原样透传输入。
   */
  private _validateToolInput(
    tool: Tool,
    toolUse: ToolUseContent,
  ): { ok: true; value: Record<string, unknown> } | { ok: false; error: StructuredToolError } {
    const schema = tool.parameters as z.ZodSchema<Record<string, unknown>> | undefined;
    if (typeof schema?.safeParse !== "function") {
      return { ok: true, value: toolUse.input };
    }

    const parsed = schema.safeParse(toolUse.input);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }

    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    const message = `Invalid input for tool ${toolUse.name}: ${issues}`;
    return {
      ok: false,
      error: { ok: false, summary: message, error: message, code: "INVALID_TOOL_INPUT" },
    };
  }

  private async _act(execution: AgentExecution, toolUses: ToolUseContent[]): Promise<ToolMessage[]> {
    const signal = execution.signal;
    const handoffUses = toolUses.filter((toolUse) => this._isHandoffToolName(toolUse.name));
    if (handoffUses.length > 0 && toolUses.length !== 1) {
      return this._appendToolResults(
        execution,
        toolUses.map((toolUse, index) => ({
          index,
          toolUseId: toolUse.id,
          toolName: toolUse.name,
          result: {
            ok: false,
            summary: "Handoff must be the only tool use in a model message.",
            error: "Handoff must be the only tool use in a model message.",
            code: "HANDOFF_MUST_BE_EXCLUSIVE",
          },
        })),
      );
    }
    let ordinaryToolCount = toolUses.filter((toolUse) => toolUse.name !== "delegate_task").length;
    let resolveOrdinaryTools!: () => void;
    const ordinaryToolsDone = new Promise<void>((resolve) => {
      resolveOrdinaryTools = resolve;
    });
    if (ordinaryToolCount === 0) {
      resolveOrdinaryTools();
    }
    const noteOrdinaryToolDone = (toolUse: ToolUseContent) => {
      if (toolUse.name === "delegate_task") return;
      ordinaryToolCount--;
      if (ordinaryToolCount === 0) {
        resolveOrdinaryTools();
      }
    };
    const tools = this._effectiveTools(execution, { beforeDelegationWait: ordinaryToolsDone });
    const executor = new ToolExecutor({
      middlewares: this.middlewares,
      agentContext: this._context,
      recordDryRunEntry: (entry) => this._runtime.recordDryRunEntry(entry),
    });
    const pending = toolUses.map(async (toolUse, index) => {
      try {
        const tool = tools.find((t) => t.name === toolUse.name);
        if (!tool) throw new Error(`Tool ${toolUse.name} not found`);
        // 在执行边界统一校验 model 提供的输入：所有 tool（不只那些记得自行解析的）
        // 都拿到经 schema 校验的输入，畸形调用以结构化、model 可恢复的错误失败，
        // 而不是各自抛 undefined 崩溃。
        const input = this._validateToolInput(tool, toolUse);
        if (!input.ok) {
          return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: input.error };
        }
        const record = await executor.invoke({
          id: toolUse.id,
          tool,
          toolName: toolUse.name,
          input: input.value,
          mode: execution.mode,
          execution,
        });
        return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: record.outcome };
      } catch (error) {
        if (error instanceof ExecutionCheckpointError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        return { index, toolUseId: toolUse.id, toolName: toolUse.name, result: `Error: ${message}` };
      } finally {
        noteOrdinaryToolDone(toolUse);
      }
    });

    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      : null;

    const remaining = new Set(pending.map((_, i) => i));
    const toolMessages: ToolMessage[] = [];
    while (remaining.size > 0) {
      const candidates = [...remaining].map((i) => pending[i]);
      const resolved = (await (abortPromise ? Promise.race([...candidates, abortPromise]) : Promise.race(candidates)))!;
      remaining.delete(resolved.index);
      if (execution.terminal) {
        return toolMessages;
      }

      toolMessages.push(...(await this._appendToolResults(execution, [resolved])));
    }
    return toolMessages;
  }

  private async _appendToolResults(
    execution: AgentExecution,
    results: Array<{ toolUseId: string; toolName: string; result: unknown }>,
  ): Promise<ToolMessage[]> {
    const messages: ToolMessage[] = [];
    for (const resolved of results) {
      if (execution.terminal) return messages;
      const toolMessage: ToolMessage = {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: resolved.toolUseId,
            content: formatToolResultForMessage({ toolName: resolved.toolName, result: resolved.result }),
          },
        ],
      };
      this._appendMessage(toolMessage);
      execution.appendMessage(toolMessage);
      execution.emitAgentEvent({ type: "message", message: toolMessage });
      messages.push(toolMessage);
    }
    return messages;
  }

  private _effectiveTools(execution: AgentExecution, options: { beforeDelegationWait?: Promise<void> } = {}): Tool[] {
    const tools = [...(this.tools ?? [])];
    const delegates = this._runtime.getDelegates(execution);
    if (delegates.length > 0 && !tools.some((tool) => tool.name === "delegate_task")) {
      tools.push(
        createDelegateTaskTool({ runtime: this._runtime, parent: execution, beforeWait: options.beforeDelegationWait }),
      );
    }
    for (const handoff of this._runtime.getHandoffs(execution)) {
      tools.push(this._createHandoffTool(execution, handoff));
    }
    return tools;
  }

  private _createHandoffTool(execution: AgentExecution, handoff: HandoffDefinition): Tool {
    return {
      name: handoffToolName(handoff.target),
      description: handoff.description,
      parameters: handoff.input,
      effect: {
        kind: "control",
        scope: "process",
        description: "Transfer control to another agent in the same execution branch.",
      },
      execute: async (input, context) =>
        this._runtime.handoff(execution, {
          target: handoff.target,
          input,
          toolUseId: context && "toolCallId" in context ? context.toolCallId : undefined,
        }),
    };
  }

  private _isHandoffToolName(name: string) {
    return name.startsWith("handoff_to_");
  }

  private _appendMessage(message: NonSystemMessage) {
    this.messages.push(message);
  }

  private async _beforeModel(modelContext: ModelContext) {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.beforeModel) continue;
      const result = await middleware.beforeModel({ modelContext, agentContext: this._context });
      if (result) {
        Object.assign(modelContext, result);
      }
    }
  }

  private async _prepareContext(execution: AgentExecution, modelContext: ModelContext) {
    if (!this.contextManager || (this.contextManager.enabledForModel && !this.contextManager.enabledForModel(this.model))) return;
    execution.emitAgentEvent({ type: "context", status: "started" });
    try {
      const prepared = await this.contextManager.prepare({
        prompt: modelContext.prompt,
        messages: modelContext.messages,
        tools: modelContext.tools,
        model: this.model,
        signal: execution.signal,
        branchLineageId: execution.branchId,
        canonicalAppendOnly: modelContext.messages === this.messages,
      });
      modelContext.messages = prepared.messages;
      execution.noteTokenUsage(prepared.usage);
      if (this._runtime.isTreeTokenLimitExceeded(execution)) {
        execution.limit(executionError("TOKEN_LIMIT_EXCEEDED", "Execution tree token limit exceeded."));
        return;
      }
      execution.emitAgentEvent({
        type: "context",
        status: "completed",
        resultTokens: prepared.estimatedTokens,
        nodeIds: prepared.stateUpdate?.appendNodes.map((node) => node.id) ?? [],
        ...(prepared.path ? { path: prepared.path } : {}),
        ...(prepared.reusedNodeCount !== undefined ? { reusedNodeCount: prepared.reusedNodeCount } : {}),
        ...(prepared.createdNodeCount !== undefined ? { createdNodeCount: prepared.createdNodeCount } : {}),
        ...(prepared.compactedTurnCount !== undefined
          ? { compactedTurnCount: prepared.compactedTurnCount }
          : {}),
      });
    } catch (error) {
      const info =
        error instanceof ContextError
          ? error.toExecutionError()
          : executionError("CONTEXT_SUMMARY_FAILED", error instanceof Error ? error.message : String(error), true);
      execution.emitAgentEvent({ type: "context", status: "failed", error: info });
      throw error;
    }
  }

  private async _afterModel(message: AssistantMessage) {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.afterModel) continue;
      const result = await middleware.afterModel({ agentContext: this._context, message });
      if (result) {
        Object.assign(message, result);
      }
    }
  }

  private async _beforeAgentRun() {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.beforeAgentRun) continue;
      const result = await middleware.beforeAgentRun({ agentContext: this._context });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _afterAgentRun() {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.afterAgentRun) continue;
      const result = await middleware.afterAgentRun({ agentContext: this._context });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _beforeAgentStep(step: number) {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.beforeAgentStep) continue;
      const result = await middleware.beforeAgentStep({ agentContext: this._context, step });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private async _afterAgentStep(step: number) {
    for (const middleware of this.middlewares) {
      if (this._shouldSkipMiddlewareForDryRun(middleware, this._activeExecution?.mode)) continue;
      if (!middleware.afterAgentStep) continue;
      const result = await middleware.afterAgentStep({ agentContext: this._context, step });
      if (result) {
        Object.assign(this._context, result);
      }
    }
  }

  private _findForbiddenDryRunMiddleware(
    execution: AgentExecution,
  ): (AgentMiddleware & { dryRun: { mode: "forbidden"; reason: string } }) | undefined {
    if (execution.mode !== "dry_run") return undefined;
    return this.middlewares.find(
      (middleware): middleware is AgentMiddleware & { dryRun: { mode: "forbidden"; reason: string } } =>
        middleware.dryRun?.mode === "forbidden",
    );
  }

  private _shouldSkipMiddlewareForDryRun(middleware: AgentMiddleware, mode?: "execute" | "dry_run") {
    return mode === "dry_run" && middleware.dryRun?.mode === "skip";
  }

}

function errorForStream(result: ExecutionResult | ExecutionBranchResult): Error {
  if (result.status === "cancelled") {
    return new DOMException(result.error?.message ?? "Execution cancelled.", "AbortError");
  }
  return new Error(result.error?.message ?? `Agent execution ended with status ${result.status}.`);
}

function validateAgentId(id: AgentId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error(`Invalid agent id: ${id}. Use lowercase letters, numbers, and dashes.`);
  }
}

function validateHandoffs(options: {
  agentId: AgentId;
  tools?: Tool[];
  delegates?: DelegateDefinition[];
  handoffs?: HandoffDefinition[];
}) {
  const seenTargets = new Set<string>();
  const reservedToolNames = new Set([...(options.tools ?? []).map((tool) => tool.name)]);
  if ((options.delegates ?? []).length > 0) reservedToolNames.add("delegate_task");

  for (const handoff of options.handoffs ?? []) {
    validateAgentId(handoff.target);
    if (handoff.target === options.agentId) {
      throw new Error(`Agent ${options.agentId} cannot hand off directly to itself.`);
    }
    if (seenTargets.has(handoff.target)) {
      throw new Error(`Duplicate handoff target: ${handoff.target}.`);
    }
    seenTargets.add(handoff.target);

    const wireName = handoffToolName(handoff.target);
    if (reservedToolNames.has(wireName)) {
      throw new Error(`Handoff tool name conflicts with an existing tool: ${wireName}.`);
    }
  }
}

function validateTools(tools: readonly Tool[] | undefined, strict: boolean): void {
  const seen = new Set<string>();
  const effectKinds = new Set(["read", "ephemeral", "interaction", "control", "mutation", "unknown"]);
  const effectScopes = new Set(["process", "workspace", "application", "system", "external"]);
  for (const tool of tools ?? []) {
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}.`);
    seen.add(tool.name);
    if (
      !tool.effect ||
      !effectKinds.has(tool.effect.kind) ||
      !effectScopes.has(tool.effect.scope) ||
      !tool.effect.description?.trim()
    ) {
      throw new Error(`Invalid effect declaration for tool ${tool.name}.`);
    }
    if (strict && tool.effect.kind === "unknown") {
      throw new Error(`Strict tool registration rejects unknown effect for tool ${tool.name}.`);
    }
    if (strict && tool.effect.kind === "mutation" && !tool.preview) {
      throw new Error(`Strict tool registration requires a preview for mutation tool ${tool.name}.`);
    }
  }
}

function handoffToolName(target: string) {
  return `handoff_to_${target.replaceAll("-", "_")}`;
}
