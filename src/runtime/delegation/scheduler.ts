import type { AgentExecution } from "@/runtime/execution/agent-execution";
import type { DelegationLimits } from "@/runtime/execution/types";

type QueueEntry = {
  execution: AgentExecution;
  parentExecutionId: string;
  rootExecutionId: string;
  start: () => void;
  cleanup?: () => void;
};

export class DelegationScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly runningByParent = new Map<string, number>();
  private readonly runningByTree = new Map<string, number>();
  private readonly runningExecutions = new Set<string>();
  private runningTotal = 0;

  constructor(private readonly limits: DelegationLimits) {}

  schedule(entry: QueueEntry) {
    if (this.canStart(entry)) {
      this.acquire(entry);
      entry.execution.startRunning();
      entry.start();
      return;
    }
    entry.execution.startQueued();
    this.queue.push(entry);
  }

  release(execution: AgentExecution) {
    if (!execution.parentExecutionId) return;
    if (!this.runningExecutions.delete(execution.id)) return;
    this.runningTotal = Math.max(0, this.runningTotal - 1);
    this.decrement(this.runningByParent, execution.parentExecutionId);
    this.decrement(this.runningByTree, execution.rootExecutionId);
    this.drain();
  }

  async reacquire(execution: AgentExecution): Promise<boolean> {
    if (!execution.parentExecutionId || execution.terminal) return false;
    const entry: QueueEntry = {
      execution,
      parentExecutionId: execution.parentExecutionId,
      rootExecutionId: execution.rootExecutionId,
      start: () => {},
    };
    if (this.canStart(entry)) {
      this.acquire(entry);
      execution.setActive();
      return true;
    }

    execution.setWaitingForPermit();
    return new Promise((resolve) => {
      const onAbort = () => {
        this.removeQueued(entry);
        resolve(false);
      };
      entry.start = () => {
        entry.cleanup?.();
        execution.setActive();
        resolve(true);
      };
      entry.cleanup = () => execution.signal.removeEventListener("abort", onAbort);
      execution.signal.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  cancelQueued(execution: AgentExecution) {
    for (const entry of this.queue.filter((item) => item.execution === execution)) {
      this.removeQueued(entry);
      entry.cleanup?.();
    }
  }

  private drain() {
    for (let i = 0; i < this.queue.length; ) {
      const entry = this.queue[i]!;
      if (!this.canStart(entry)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      if (entry.execution.terminal) continue;
      this.acquire(entry);
      entry.execution.startRunning();
      entry.start();
    }
  }

  private canStart(entry: QueueEntry) {
    return (
      (this.runningByParent.get(entry.parentExecutionId) ?? 0) < this.limits.maxConcurrentPerParent &&
      (this.runningByTree.get(entry.rootExecutionId) ?? 0) < this.limits.maxConcurrentPerTree &&
      this.runningTotal < this.limits.maxConcurrentDelegatedExecutions
    );
  }

  private acquire(entry: QueueEntry) {
    if (this.runningExecutions.has(entry.execution.id)) return;
    this.runningExecutions.add(entry.execution.id);
    this.runningTotal++;
    this.increment(this.runningByParent, entry.parentExecutionId);
    this.increment(this.runningByTree, entry.rootExecutionId);
  }

  private removeQueued(entry: QueueEntry) {
    const index = this.queue.indexOf(entry);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
  }

  private increment(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private decrement(map: Map<string, number>, key: string) {
    const next = Math.max(0, (map.get(key) ?? 0) - 1);
    if (next === 0) {
      map.delete(key);
    } else {
      map.set(key, next);
    }
  }
}
