import { describe, expect, test } from "bun:test";

import type { ApprovalDecision } from "@/coding/permissions/approval-types";
import { createCodingApprovalMiddleware } from "@/coding/permissions/coding-approval-middleware";
import type { AgentContext, ExecutionSnapshot } from "@/runtime";

function makeInvocation(name: string) {
  return {
    id: "tc_1",
    toolName: name,
    input: {},
    mode: "execute",
    tool: {} as never,
    execution: { signal: new AbortController().signal, getSnapshot: () => mockExecution } as never,
  } as const;
}

const mockAgentContext: AgentContext = { prompt: "", messages: [], tools: [] };
const mockExecution: ExecutionSnapshot = {
  id: "exec-1",
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

describe("createCodingApprovalMiddleware", () => {
  test("allows tools not in the requiresApproval list", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell", "write_file"],
      askUser: async () => "deny" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      invocation: makeInvocation("read_file"),
    });

    expect(result).toBeUndefined();
  });

  test("asks user for tools in the requiresApproval list", async () => {
    let asked = false;
    let executionId: string | undefined;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell"],
      askUser: async (_toolUse, options) => {
        asked = true;
        executionId = options?.execution?.id;
        return "allow_once" as ApprovalDecision;
      },
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
invocation: makeInvocation("shell"),
      execution: mockExecution,
    });

    expect(asked).toBe(true);
    expect(executionId).toBe("exec-1");
    expect(result).toBeUndefined();
  });

  test("skips approval when tool is in the allow list", async () => {
    let asked = false;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell"],
      askUser: async () => {
        asked = true;
        return "allow_once" as ApprovalDecision;
      },
      approvalPersistence: {
loadAllowList: async () => new Set(["shell"]),
        persistAllowedTool: async () => {},
      },
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
invocation: makeInvocation("shell"),
    });

    expect(asked).toBe(false);
    expect(result).toBeUndefined();
  });

  test("returns skip result when user denies", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["shell"],
      askUser: async () => "deny" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
      invocation: makeInvocation("shell"),
    });

    expect(result).toMatchObject({
      action: "reject",
      result: {
        ok: false,
        code: "TOOL_USE_DENIED",
summary: expect.stringContaining("User denied execution of tool: shell"),
error: expect.stringContaining("User denied execution of tool: shell"),
      },
    });
  });

  test("persists tool when user allows always for project", async () => {
    let persistedTool: string | undefined;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
      approvalPersistence: {
        loadAllowList: async () => new Set(),
        persistAllowedTool: async (_cwd, toolName) => {
          persistedTool = toolName;
        },
      },
    });

    await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
invocation: makeInvocation("shell"),
    });

expect(persistedTool).toBe("shell");
  });

  test("does not throw when persistence fails on allow_always_project", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
      approvalPersistence: {
        loadAllowList: async () => new Set(),
        persistAllowedTool: async () => {
          throw new Error("disk full");
        },
      },
    });

    // 持久化出错也不应抛异常
    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
invocation: makeInvocation("shell"),
    });

    expect(result).toBeUndefined();
  });

  test("works without approvalPersistence", async () => {
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
requiresApproval: ["shell"],
      askUser: async () => "allow_always_project" as ApprovalDecision,
    });

    const result = await middleware.beforeToolUse?.({
      agentContext: mockAgentContext,
invocation: makeInvocation("shell"),
    });

    expect(result).toBeUndefined();
  });

  test("uses one Turn allow-list snapshot for subsequent tool calls", async () => {
    let loads = 0;
    let asked = 0;
    const middleware = createCodingApprovalMiddleware({
      cwd: "/tmp",
      requiresApproval: ["shell"],
      askUser: async () => {
        asked++;
        return "allow_once" as ApprovalDecision;
      },
      approvalPersistence: {
        loadAllowList: async () => {
          loads++;
          return new Set();
        },
        persistAllowedTool: async () => {},
      },
    });
    await middleware.beforeToolUse?.({ agentContext: mockAgentContext, invocation: makeInvocation("shell") });
    await middleware.beforeToolUse?.({ agentContext: mockAgentContext, invocation: makeInvocation("shell") });
    expect(loads).toBe(1);
    expect(asked).toBe(2);
  });
});
