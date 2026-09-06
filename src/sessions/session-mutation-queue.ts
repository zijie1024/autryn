import type { SessionId } from "./session-types";

/**
 * Serializes asynchronous mutations independently for each Session.
 * A rejected operation must not poison the following operation in the same queue.
 */
export class SessionMutationQueue {
  private readonly tails = new Map<SessionId, Promise<void>>();

  async run<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => operation());
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId);
      }
    }
  }
}
