export interface MemoryEventBase {
  type: "memory";
  adapterKind: string;
  scope: "global" | "project";
  scopeId: string;
  agentId?: string;
  executionId?: string;
  timestamp: string;
}

export type MemoryEvent = MemoryEventBase &
  (
    | { status: "bootstrap_loaded"; documentCount: number }
    | { status: "recalled"; reference: string }
    | { status: "previewed"; reference: string; operation: string }
    | { status: "committed"; reference: string; operation: string }
    | { status: "conflict"; reference: string }
    | { status: "warning"; code: string }
  );

export interface MemoryObserver {
  onMemoryEvent(event: MemoryEvent): void | Promise<void>;
}

/** 组合层可选回调；Observer 抛错不应中断 Agent Loop。 */
export function emitMemoryEvent(observer: MemoryObserver | undefined, event: MemoryEvent): void {
  if (!observer) return;
  try {
    void Promise.resolve(observer.onMemoryEvent(event)).catch(() => {});
  } catch {
    // 观察型回调失败不回滚业务结果。
  }
}
