import type { AskUserQuestionParameters, AskUserQuestionResult } from "./ask-user-question";

export type AskUserQuestionRequest = {
  params: AskUserQuestionParameters;
  resolve: (result: AskUserQuestionResult) => void;
};

const MAX_QUEUE_SIZE = 20;

export class AskUserQuestionManager {
  private _queue: AskUserQuestionRequest[] = [];
  private _currentRequest?: AskUserQuestionRequest;
  private _subscriber?: (req: AskUserQuestionRequest | null) => void;

  askUserQuestion = (params: AskUserQuestionParameters): Promise<AskUserQuestionResult> => {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= MAX_QUEUE_SIZE) {
        console.warn("[AskUserQuestionManager] Queue overflow; rejecting request.");
        reject(new Error("Ask user question queue overflow"));
        return;
      }
      this._queue.push({ params, resolve });
      this._processQueue();
    });
  };

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

  respondWithAnswers = (result: AskUserQuestionResult) => {
    if (!this._currentRequest) return;
    this._currentRequest.resolve(result);
    this._currentRequest = undefined;
    this._processQueue();
  };

  subscribe(callback: (req: AskUserQuestionRequest | null) => void) {
    this._subscriber = callback;
    this._processQueue();
    return () => {
      this._subscriber = undefined;
    };
  }
}

export const globalAskUserQuestionManager = new AskUserQuestionManager();
