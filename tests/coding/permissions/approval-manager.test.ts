import { describe, expect, test } from "bun:test";

import { ApprovalManager } from "@/coding/permissions/approval-manager";
import type { ApprovalDecision } from "@/coding/permissions/approval-types";
import type { ToolUseContent } from "@/core";
import type { ExecutionSnapshot } from "@/runtime";

function makeToolUse(name: string): ToolUseContent {
  return { type: "tool_use", id: "tc_1", name, input: {} };
}

function makeExecution(id = "exec-1"): ExecutionSnapshot {
  return {
    id,
    branchId: "branch-1",
    rootExecutionId: "root-1",
    agentId: "agent-1",
    depth: 1,
    status: "running",
    createdAt: 100,
    steps: 0,
    handoffIndex: 0,
    mode: "execute",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageIncomplete: false },
  };
}

describe("ApprovalManager", () => {
  test("askUser queues a request and subscriber receives it", async () => {
    const manager = new ApprovalManager();
  const toolUse = makeToolUse("shell");

    const received: ToolUseContent[] = [];
    manager.subscribe((req) => {
      if (req) received.push(req.toolUse);
    });

    const promise = manager.askUser(toolUse);
    expect(received).toHaveLength(1);
  expect(received[0]!.name).toBe("shell");

    // resolve，以免 promise 挂起
    manager.respond("allow_once");
    const decision = await promise;
    expect(decision).toBe("allow_once");
  });

  test("request carries content-free execution identity", async () => {
    const manager = new ApprovalManager();
    const execution = makeExecution("child-1");
    let seen: ExecutionSnapshot | undefined;
    manager.subscribe((req) => {
      if (req) seen = req.execution;
    });

  const promise = manager.askUser(makeToolUse("shell"), { execution });
    manager.respond("allow_once");

    await expect(promise).resolves.toBe("allow_once");
    expect(seen).toMatchObject({ id: "child-1", rootExecutionId: "root-1" });
    expect(seen).not.toHaveProperty("messages");
  });

  test("aborted execution removes stale current approval request", async () => {
    const manager = new ApprovalManager();
    const controller = new AbortController();
    const seen: Array<string | null> = [];
    manager.subscribe((req) => {
      seen.push(req?.toolUse.name ?? null);
    });

    const promise = manager.askUser(makeToolUse("shell"), { execution: makeExecution(), signal: controller.signal });
    controller.abort();

    await expect(promise).resolves.toBe("deny");
    expect(seen).toContain("shell");
    expect(seen.at(-1)).toBeNull();
  });

  test("aborted queued approval is denied without disturbing current request", async () => {
    const manager = new ApprovalManager();
    const controller = new AbortController();

  const p1 = manager.askUser(makeToolUse("shell"));
    const p2 = manager.askUser(makeToolUse("write_file"), {
      execution: makeExecution("child-2"),
      signal: controller.signal,
    });
    controller.abort();
    manager.respond("allow_once");

    await expect(p1).resolves.toBe("allow_once");
    await expect(p2).resolves.toBe("deny");
  });

  test("respond resolves the pending request with the decision", async () => {
    const manager = new ApprovalManager();
    const toolUse = makeToolUse("write_file");

    const promise = manager.askUser(toolUse);
    manager.respond("deny");

    const decision = await promise;
    expect(decision).toBe("deny");
  });

  test("respond does nothing when no request is pending", () => {
    const manager = new ApprovalManager();
    expect(() => manager.respond("allow_once")).not.toThrow();
  });

  test("processes queued requests sequentially", async () => {
    const manager = new ApprovalManager();
    const decisions: ApprovalDecision[] = [];

  const p1 = manager.askUser(makeToolUse("shell"));
    const p2 = manager.askUser(makeToolUse("write_file"));

    // 只有第一个应处于活动状态
    manager.respond("allow_once");
    decisions.push(await p1);

    // 第一个 resolve 后，第二个变为活动
    manager.respond("deny");
    decisions.push(await p2);

    expect(decisions).toEqual(["allow_once", "deny"]);
  });

  test("subscriber receives null when queue empties", async () => {
    const manager = new ApprovalManager();
    const events: (ToolUseContent | null)[] = [];

    manager.subscribe((req) => {
      events.push(req?.toolUse ?? null);
    });

  const promise = manager.askUser(makeToolUse("shell"));
    manager.respond("allow_once");
    await promise;

    // resolve 后，订阅者应收到 null
    expect(events).toContain(null);
  });

  test("subscribe returns unsubscribe function", async () => {
    const manager = new ApprovalManager();
    const events: (ToolUseContent | null)[] = [];

    const unsubscribe = manager.subscribe((req) => {
      events.push(req?.toolUse ?? null);
    });

    const promise = manager.askUser(makeToolUse("shell"));
    manager.respond("allow_once");
    await promise;

    expect(events.length).toBeGreaterThan(0);
    const countBefore = events.length;

    // 取消订阅后，新请求不应触发回调
    unsubscribe();
    const promise2 = manager.askUser(makeToolUse("write_file"));
    manager.respond("deny");
    await promise2;

    // 取消订阅后没有新事件（队列清空时的 null 可能已触发）
    expect(events.length).toBe(countBefore);
  });
});
