import type { AssistantMessage, NonSystemMessage } from "@/core";
import type { AgentEvent } from "@/runtime/events/agent-event";
import type {
  ExecutionErrorInfo,
  ExecutionEvent,
  ExecutionResult,
  ExecutionSnapshot,
  ExecutionStatus,
  ExecutionUsage,
  ExecutionTerminalStatus,
  HandoffEventPayload,
  ToolRuntimeEvent,
} from "@/runtime/execution/types";

const terminalStatuses = new Set<ExecutionStatus>([
  "handed_off",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "limit_exceeded",
]);

type QueueItem<T> = IteratorResult<T>;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: QueueItem<T>[] = [];
  private readonly waiters: Array<(value: QueueItem<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    this._push({ value, done: false });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this._push({ value: undefined, done: true });
  }

  private _push(item: QueueItem<T>) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.values.push(item);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve(value);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<QueueItem<T>>((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface AgentExecutionOptions {
  id: string;
  parentExecutionId?: string;
  rootExecutionId: string;
  branchId: string;
  agentId: string;
  agentName?: string;
  delegateName?: string;
  depth: number;
  handoffIndex?: number;
  predecessorExecutionId?: string;
  mode?: "execute" | "dry_run";
  now: () => number;
  metadata?: Record<string, string>;
  onStatus?: (execution: AgentExecution) => void;
  onTerminal?: (execution: AgentExecution) => void;
  timeoutMs?: number;
  /** Absolute branch deadline inherited by Handoff successors. */
  deadlineAt?: number;
}

export class AgentExecution {
  private readonly controller = new AbortController();
  private readonly queue = new AsyncEventQueue<ExecutionEvent>();
  private readonly messages: NonSystemMessage[] = [];
  private readonly metadata: Record<string, string>;
  private readonly now: () => number;
  private readonly onStatus?: (execution: AgentExecution) => void;
  private readonly onTerminal?: (execution: AgentExecution) => void;
  private sequence = 0;
  private _status: ExecutionStatus = "created";
  private _activity: ExecutionSnapshot["activity"];
  private _startedAt?: number;
  private _endedAt?: number;
  private _steps = 0;
  private _usage: ExecutionUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageIncomplete: false };
  private _error?: ExecutionErrorInfo;
  private timeout?: ReturnType<typeof setTimeout>;
  private resolveResult!: (result: ExecutionResult) => void;

  readonly id: string;
  readonly parentExecutionId?: string;
  readonly rootExecutionId: string;
  readonly branchId: string;
  readonly agentId: string;
  readonly agentName?: string;
  readonly delegateName?: string;
  readonly depth: number;
  readonly handoffIndex: number;
  readonly predecessorExecutionId?: string;
  successorExecutionId?: string;
  readonly mode: "execute" | "dry_run";
  readonly createdAt: number;
  readonly deadlineAt?: number;
  readonly signal = this.controller.signal;
  readonly events: AsyncIterable<ExecutionEvent> = this.queue;
  readonly result: Promise<ExecutionResult>;

  constructor(options: AgentExecutionOptions) {
    this.id = options.id;
    this.parentExecutionId = options.parentExecutionId;
    this.rootExecutionId = options.rootExecutionId;
    this.branchId = options.branchId;
    this.agentId = options.agentId;
    this.agentName = options.agentName;
    this.delegateName = options.delegateName;
    this.depth = options.depth;
    this.handoffIndex = options.handoffIndex ?? 0;
    this.predecessorExecutionId = options.predecessorExecutionId;
    this.mode = options.mode ?? "execute";
    this.createdAt = options.now();
    this.deadlineAt = options.deadlineAt ?? (options.timeoutMs !== undefined ? this.createdAt + options.timeoutMs : undefined);
    this.now = options.now;
    this.metadata = { ...(options.metadata ?? {}) };
    this.onStatus = options.onStatus;
    this.onTerminal = options.onTerminal;
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    if (this.deadlineAt !== undefined) {
      const timeoutMs = Math.max(0, this.deadlineAt - this.createdAt);
      this.timeout = setTimeout(() => {
        this.controller.abort(new DOMException("Execution timed out.", "TimeoutError"));
        this.finish("timed_out", executionError("EXECUTION_TIMEOUT", "Execution timed out."));
      }, timeoutMs);
    }
    this.emitLifecycle();
  }

  get status() {
    return this._status;
  }

  get terminal() {
    return terminalStatuses.has(this._status);
  }

  startQueued() {
    this.transition("queued", "waiting_for_permit");
  }

  startRunning() {
    this._startedAt ??= this.now();
    this.transition("running", "active");
  }

  setWaitingForChildren() {
    if (this._status === "running") {
      this._activity = "waiting_for_children";
      this.onStatus?.(this);
    }
  }

  setWaitingForPermit() {
    if (this._status === "running") {
      this._activity = "waiting_for_permit";
      this.onStatus?.(this);
    }
  }

  setActive() {
    if (this._status === "running") {
      this._activity = "active";
      this.onStatus?.(this);
    }
  }

  noteStep() {
    this._steps++;
  }

  noteUsage(message: AssistantMessage) {
    if (!message.usage) {
      this._usage.usageIncomplete = true;
      return;
    }
    this.noteTokenUsage(message.usage);
  }

  noteTokenUsage(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usageIncomplete?: boolean;
  }) {
    this._usage.promptTokens += usage.promptTokens;
    this._usage.completionTokens += usage.completionTokens;
    this._usage.totalTokens += usage.totalTokens;
    this._usage.usageIncomplete ||= Boolean(usage.usageIncomplete);
  }

  appendMessage(message: NonSystemMessage) {
    this.messages.push(message);
  }

  emitAgentEvent(event: AgentEvent) {
    this.queue.push({
      ...event,
      ...this.eventBase(),
    });
  }

  emitHandoffEvent(event: HandoffEventPayload) {
    this.queue.push({
      ...event,
      ...this.eventBase(),
    });
  }

  emitToolEvent(event: Omit<ToolRuntimeEvent, keyof ReturnType<AgentExecution["eventBase"]>>) {
    this.queue.push({
      ...event,
      ...this.eventBase(),
    });
  }

  cancel(reason = "Execution cancelled.") {
    this.controller.abort(new DOMException(reason, "AbortError"));
    this.finish("cancelled", executionError("EXECUTION_CANCELLED", reason));
  }

  fail(error: ExecutionErrorInfo) {
    this.finish("failed", error);
  }

  limit(error: ExecutionErrorInfo) {
    this.finish("limit_exceeded", error);
  }

  complete(output?: ExecutionResult["output"]) {
    this.finish("completed", undefined, output);
  }

  handoff(successorExecutionId: string) {
    this.successorExecutionId = successorExecutionId;
    this.finish("handed_off");
  }

  finish(status: ExecutionTerminalStatus, error?: ExecutionErrorInfo, output?: ExecutionResult["output"]) {
    if (this.terminal) return;
    this._status = status;
    this._activity = undefined;
    this._endedAt = this.now();
    this._error = error;
    if ((status === "cancelled" || status === "timed_out") && !this.controller.signal.aborted) {
      this.controller.abort(
        new DOMException(error?.message ?? status, status === "timed_out" ? "TimeoutError" : "AbortError"),
      );
    }
    if (this.timeout) clearTimeout(this.timeout);
    this.emitLifecycle();
    this.queue.close();
    const result: ExecutionResult = {
      executionId: this.id,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      rootExecutionId: this.rootExecutionId,
      branchId: this.branchId,
      agentId: this.agentId,
      mode: this.mode,
      status,
      ...(output ? { output } : {}),
      steps: this._steps,
      usage: { ...this._usage },
      durationMs: Math.max(0, this._endedAt - this.createdAt),
      ...(error ? { error } : {}),
    };
    this.resolveResult(result);
    this.onTerminal?.(this);
  }

  getSnapshot(): ExecutionSnapshot {
    return {
      id: this.id,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      rootExecutionId: this.rootExecutionId,
      branchId: this.branchId,
      agentId: this.agentId,
      ...(this.agentName ? { agentName: this.agentName } : {}),
      ...(this.delegateName ? { delegateName: this.delegateName } : {}),
      depth: this.depth,
      handoffIndex: this.handoffIndex,
      ...(this.predecessorExecutionId ? { predecessorExecutionId: this.predecessorExecutionId } : {}),
      ...(this.successorExecutionId ? { successorExecutionId: this.successorExecutionId } : {}),
      mode: this.mode,
      status: this._status,
      ...(this._activity ? { activity: this._activity } : {}),
      createdAt: this.createdAt,
      ...(this._startedAt ? { startedAt: this._startedAt } : {}),
      ...(this._endedAt ? { endedAt: this._endedAt } : {}),
      steps: this._steps,
      usage: { ...this._usage },
      ...(this._error ? { error: this._error } : {}),
    };
  }

  getMessagesSnapshot(): readonly NonSystemMessage[] {
    return this.messages.map((message) => structuredClone(message));
  }

  getMetadata(): Readonly<Record<string, string>> {
    return { ...this.metadata };
  }

  private transition(status: ExecutionStatus, activity?: ExecutionSnapshot["activity"]) {
    if (this.terminal || this._status === status) return;
    this._status = status;
    this._activity = activity;
    this.emitLifecycle();
  }

  private emitLifecycle() {
    this.queue.push({
      type: "lifecycle",
      status: this._status,
      ...this.eventBase(),
    });
    this.onStatus?.(this);
  }

  private eventBase() {
    return {
      executionId: this.id,
      ...(this.parentExecutionId ? { parentExecutionId: this.parentExecutionId } : {}),
      rootExecutionId: this.rootExecutionId,
      branchId: this.branchId,
      agentId: this.agentId,
      depth: this.depth,
      sequence: ++this.sequence,
      timestamp: this.now(),
    };
  }
}

export function executionError(
  code: ExecutionErrorInfo["code"],
  message: string,
  retryable = false,
): ExecutionErrorInfo {
  return { code, message, retryable };
}

export function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
}

export function sanitizeAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    role: "assistant",
    content: message.content.filter((content) => content.type === "text" || content.type === "tool_use"),
    ...(message.usage ? { usage: { ...message.usage } } : {}),
  };
}
