import { describe, expect, test } from "bun:test";

import { SessionMutationQueue } from "@/sessions/session-mutation-queue";

describe("SessionMutationQueue", () => {
  test("serializes one Session while allowing another Session to proceed", async () => {
    const queue = new SessionMutationQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("session-a", async () => {
      events.push("a-1-start");
      await firstGate;
      events.push("a-1-end");
      return 1;
    });
    const second = queue.run("session-a", async () => {
      events.push("a-2-start");
      return 2;
    });
    const other = queue.run("session-b", async () => {
      events.push("b-1");
      return 3;
    });

    await other;
    expect(events).toEqual(["a-1-start", "b-1"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["a-1-start", "b-1", "a-1-end", "a-2-start"]);
  });

  test("continues after a failed operation", async () => {
    const queue = new SessionMutationQueue();
    const failure = queue.run("session-a", async () => {
      throw new Error("mutation failed");
    });
    const recovery = queue.run("session-a", async () => "recovered");

    await expect(failure).rejects.toThrow("mutation failed");
    await expect(recovery).resolves.toBe("recovered");
  });
});
