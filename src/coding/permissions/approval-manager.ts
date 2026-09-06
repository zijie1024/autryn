import type { ToolUseContent } from "@/core";
import type { ExecutionSnapshot } from "@/runtime";

import type { ApprovalDecision } from "./approval-types";

export type ApprovalRequest = {
  toolUse: ToolUseContent;
  execution?: ExecutionSnapshot;
  resolve: (decision: ApprovalDecision) => void;
  cleanup?: () => void;
};

export type ApprovalRequestOptions = {
  execution?: ExecutionSnapshot;
  signal?: AbortSignal;
};

const MAX_QUEUE_SIZE = 20;

export class ApprovalManager {
  private _queue: ApprovalRequest[] = [];
  private _currentRequest?: ApprovalRequest;
  private _subscriber?: (req: ApprovalRequest | null) => void;

  askUser = (toolUse: ToolUseContent, options: ApprovalRequestOptions = {}): Promise<ApprovalDecision> => {
    return new Promise((resolve) => {
      if (options.signal?.aborted) {
        resolve("deny");
        return;
      }
      if (this._queue.length >= MAX_QUEUE_SIZE) {
        console.warn(`[ApprovalManager] Queue overflow. Denying tool ${toolUse.name}.`);
        resolve("deny");
        return;
      }
      const request: ApprovalRequest = { toolUse, execution: options.execution, resolve };
      if (options.signal) {
        const cancel = () => {
          this._cancelRequest(request);
        };
        options.signal.addEventListener("abort", cancel, { once: true });
        request.cleanup = () => options.signal?.removeEventListener("abort", cancel);
      }
      this._queue.push(request);
      this._processQueue();
    });
  };

  private _cancelRequest(request: ApprovalRequest) {
    const queuedIndex = this._queue.indexOf(request);
    if (queuedIndex >= 0) {
      this._queue.splice(queuedIndex, 1);
      request.cleanup?.();
      request.resolve("deny");
      this._processQueue();
      return;
    }
    if (this._currentRequest === request) {
      this._currentRequest = undefined;
      request.cleanup?.();
      request.resolve("deny");
      this._processQueue();
    }
  }

  private _processQueue() {
    if (this._currentRequest || this._queue.length === 0) {
      if (this._queue.length === 0 && !this._currentRequest) {
        this._subscriber?.(null);
      }
      return;
    }

    this._currentRequest = this._queue.shift()!;
    this._subscriber?.(this._currentRequest);
  }

  respond = (decision: ApprovalDecision) => {
    if (!this._currentRequest) return;
    this._currentRequest.cleanup?.();
    this._currentRequest.resolve(decision);
    this._currentRequest = undefined;
    this._processQueue();
  };

  subscribe(callback: (req: ApprovalRequest | null) => void) {
    this._subscriber = callback;
    this._processQueue();
    return () => {
      this._subscriber = undefined;
    };
  }
}

export const globalApprovalManager = new ApprovalManager();
