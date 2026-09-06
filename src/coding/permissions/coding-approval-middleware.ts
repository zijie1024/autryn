import type { StructuredToolError, ToolUseContent } from "@/core";
import type { ExecutionSnapshot } from "@/runtime";
import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import { errorToolResult } from "../tools/tool-result";

import type { ApprovalPersistence } from "./approval-persistence";
import type { ApprovalDecision } from "./approval-types";

const emptyAllowList = async (): Promise<Set<string>> => new Set();

export function createCodingApprovalMiddleware(options: {
  cwd: string;
  requiresApproval: string[];
  allowList?: ReadonlySet<string>;
  approvalState?: { allowedTools: Set<string> };
  approvalPersistence?: ApprovalPersistence;
  askUser: (
    toolUse: ToolUseContent,
    options?: { execution?: ExecutionSnapshot; signal?: AbortSignal },
  ) => Promise<ApprovalDecision>;
}): AgentMiddleware {
  const loadAllowList = options.approvalPersistence?.loadAllowList ?? emptyAllowList;
  const persistAllowedTool = options.approvalPersistence?.persistAllowedTool;
  let loadedAllowList: Set<string> | undefined = options.allowList ? new Set(options.allowList) : undefined;

  return {
    name: "coding-approval",
    dryRun: { mode: "compatible" },
    beforeToolUse: async ({ invocation, signal }) => {
      const toolUse: ToolUseContent = { type: "tool_use", id: invocation.id, name: invocation.toolName, input: invocation.input };
      if (!options.requiresApproval.includes(toolUse.name)) {
        return;
      }
      if (invocation.mode === "dry_run") {
        return;
      }
      const allowed = options.approvalState?.allowedTools ?? (loadedAllowList ??= await loadAllowList(options.cwd));
      if (allowed.has(toolUse.name)) {
        return;
      }
      const decision = await options.askUser(toolUse, { execution: invocation.execution.getSnapshot(), signal });
      if (decision === "deny") {
        // 拒绝必须以结构化 *error* 观察结果的形式到达 model：
        // 这里若返回普通字符串，transcript 会将其规范化为 { ok: true }，
        // 让被拒绝的动作看起来像一次成功的 tool 运行。
        return {
          action: "reject" as const,
          result: errorToolResult(
            `User denied execution of tool: ${toolUse.name}. You must either find an alternative approach or ask the user for clarification.`,
            "TOOL_USE_DENIED",
          ) as StructuredToolError,
        };
      }
      if (decision === "allow_always_project") {
        allowed.add(toolUse.name);
        if (persistAllowedTool) {
          try {
            await persistAllowedTool(options.cwd, toolUse.name);
          } catch (e) {
            console.warn(`[autryn] Could not persist allow for ${toolUse.name}:`, e);
          }
        }
      }
    },
  };
}
