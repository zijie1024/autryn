import { emptyUsage } from "@/runtime/resources/resource-ledger";

import type { AgentExecution } from "./agent-execution";
import type {
  DryRunReport,
  ExecutionBranchResult,
  ExecutionBranchSnapshot,
  ExecutionEvent,
  ExecutionUsage,
  HandoffRecord,
  TerminalExecutionStatus,
} from "./types";

type QueueItem<T> = IteratorResult<T>;

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: QueueItem<T>[] = [];
  private readonly waiters: Array<(value: QueueItem<T>) => void> = [];
  private closed = false;

  push(value: T) {
    if (this.closed) return;
    const item = { value, done: false } as QueueItem<T>;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.values.push(item);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: undefined, done: true });
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

export interface ExecutionBranchOptions {
  id: string;
  rootExecutionId: string;
  parentBranchId?: string;
  initialExecution: AgentExecution;
  now: () => number;
  dryRunReport?: (status: TerminalExecutionStatus) => DryRunReport | undefined;
}

export class ExecutionBranch {
  private readonly queue = new AsyncEventQueue<ExecutionEvent>();
  private readonly executions: AgentExecution[] = [];
  private readonly handoffs: HandoffRecord[] = [];
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly dryRunReport?: (status: TerminalExecutionStatus) => DryRunReport | undefined;
  private resolveResult!: (result: ExecutionBranchResult) => void;

  readonly id: string;
  readonly rootExecutionId: string;
  readonly parentBranchId?: string;
  readonly initialExecutionId: string;
  readonly mode: "execute" | "dry_run";
  readonly events: AsyncIterable<ExecutionEvent> = this.queue;
  readonly result: Promise<ExecutionBranchResult>;

  constructor(options: ExecutionBranchOptions) {
    this.id = options.id;
    this.rootExecutionId = options.rootExecutionId;
    this.parentBranchId = options.parentBranchId;
    this.initialExecutionId = options.initialExecution.id;
    this.mode = options.initialExecution.mode;
    this.now = options.now;
    this.startedAt = options.initialExecution.createdAt;
    this.dryRunReport = options.dryRunReport;
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
    this.attachExecution(options.initialExecution);
  }

  attachExecution(execution: AgentExecution) {
    if (this.executions.some((current) => current.id === execution.id)) return;
    this.executions.push(execution);
    void this.forwardEvents(execution);
    void execution.result.then((result) => {
      if (result.status === "handed_off") return;
      const snapshot = this.getSnapshot();
      const terminalStatus = result.status as TerminalExecutionStatus;
      this.resolveResult({
        branchId: this.id,
        executionId: result.executionId,
        agentId: result.agentId,
        ...(result.parentExecutionId ? { parentExecutionId: result.parentExecutionId } : {}),
        initialExecutionId: this.initialExecutionId,
        finalExecutionId: result.executionId,
        initialAgentId: this.executions[0]?.agentId ?? result.agentId,
        finalAgentId: result.agentId,
        rootExecutionId: this.rootExecutionId,
        status: terminalStatus,
        mode: this.mode,
        ...(result.output ? { output: result.output } : {}),
        handoffs: [...this.handoffs],
        usage: snapshot.usage,
        steps: this.getStepCount(),
        durationMs: Math.max(0, this.now() - this.startedAt),
        ...(result.error ? { error: result.error } : {}),
        ...(this.dryRunReport ? { dryRunReport: this.dryRunReport(terminalStatus) } : {}),
      });
      this.queue.close();
    });
  }

  current(): AgentExecution {
    const execution = this.executions[this.executions.length - 1];
    if (!execution) {
      throw new Error(`Branch ${this.id} has no executions.`);
    }
    return execution;
  }

  commitHandoff(record: HandoffRecord, successor: AgentExecution) {
    this.handoffs.push(record);
    this.current().handoff(successor.id);
    this.attachExecution(successor);
  }

  getMessagesSnapshot() {
    return this.executions.flatMap((execution) => execution.getMessagesSnapshot());
  }

  getStepCount() {
    return this.executions.reduce((sum, execution) => sum + execution.getSnapshot().steps, 0);
  }

  getSnapshot(): ExecutionBranchSnapshot {
    return {
      id: this.id,
      rootExecutionId: this.rootExecutionId,
      ...(this.parentBranchId ? { parentBranchId: this.parentBranchId } : {}),
      initialExecutionId: this.initialExecutionId,
      currentExecutionId: this.current().id,
      executionIds: this.executions.map((execution) => execution.id),
      handoffCount: this.handoffs.length,
      status: this.current().status === "handed_off" ? "running" : branchStatus(this.current().status),
      mode: this.mode,
      usage: aggregateUsage(this.executions),
      handoffs: [...this.handoffs],
    };
  }

  private async forwardEvents(execution: AgentExecution) {
    for await (const event of execution.events) {
      this.queue.push(event);
    }
  }
}

function branchStatus(status: AgentExecution["status"]): ExecutionBranchSnapshot["status"] {
  if (status === "created" || status === "queued" || status === "running" || status === "handed_off") {
    return "running";
  }
  return status;
}

function aggregateUsage(executions: AgentExecution[]): ExecutionUsage {
  const usage = emptyUsage();
  for (const execution of executions) {
    const current = execution.getSnapshot().usage;
    usage.promptTokens += current.promptTokens;
    usage.completionTokens += current.completionTokens;
    usage.totalTokens += current.totalTokens;
    usage.usageIncomplete ||= current.usageIncomplete;
  }
  return usage;
}
