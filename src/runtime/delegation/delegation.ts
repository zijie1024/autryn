import z from "zod";

import { defineTool, type StructuredToolError, type StructuredToolSuccess, type Tool } from "@/core";
import type { AgentRuntime } from "@/runtime/agent/runtime";
import type { AgentExecution } from "@/runtime/execution/agent-execution";
import type { DelegationRequest, DelegationResult, ExecutionBranchResult } from "@/runtime/execution/types";

const MAX_TASK_CHARS = 32_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

export const delegateTaskParametersSchema = z.object({
  agent: z.string().trim().min(1).describe("The registered child agent to delegate to."),
  task: z.string().trim().min(1).max(MAX_TASK_CHARS).describe("The task for the child agent."),
});

export function createDelegateTaskTool({
  runtime,
  parent,
  beforeWait,
}: {
  runtime: AgentRuntime;
  parent: AgentExecution;
  beforeWait?: Promise<void>;
}): Tool {
  return defineTool({
    name: "delegate_task",
    description: "Delegate a self-contained task to a registered child agent and return its structured result.",
    parameters: delegateTaskParametersSchema,
    effect: {
      kind: "control",
      scope: "process",
      description: "Starts a child execution branch without directly mutating persistent workspace state.",
    },
    execute: async ({ agent, task }, context) => {
      const result = await runtime.delegate(parent, { delegate: agent, task }, context.signal, { beforeWait });
      return formatDelegationToolResult(result);
    },
  });
}

export function formatDelegationToolResult(result: DelegationResult): StructuredToolSuccess | StructuredToolError {
  if (!result.accepted) {
    return {
      ok: false,
      summary: result.error.message,
      error: result.error.message,
      code: result.error.code,
    };
  }

  const execution = result.execution;
  if (execution.status !== "completed") {
    const message = execution.error?.message ?? `Delegated execution ended with status ${execution.status}.`;
    return {
      ok: false,
      summary: message,
      error: message,
      ...(execution.error?.code ? { code: execution.error.code } : {}),
      details: safeDetails(execution),
    };
  }

  const summary = truncate(execution.output?.text || "Delegated task completed.", MAX_TOOL_RESULT_CHARS);
  return {
    ok: true,
    summary,
    data: safeDetails(execution),
  };
}

function safeDetails(execution: ExecutionBranchResult) {
  return {
    branchId: execution.branchId,
    executionId: execution.executionId,
    agentId: execution.agentId,
    initialExecutionId: execution.initialExecutionId,
    finalExecutionId: execution.finalExecutionId,
    rootExecutionId: execution.rootExecutionId,
    finalAgentId: execution.finalAgentId,
    status: execution.status,
    steps: execution.steps,
    usage: execution.usage,
    durationMs: execution.durationMs,
  };
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 48))}... [truncated ${value.length - maxLength} chars]`;
}

export function normalizeDelegationRequest(request: DelegationRequest): DelegationRequest | StructuredToolError {
  const delegate = request.delegate.trim();
  const task = request.task.trim();
  if (!delegate) {
    return invalid("Delegate name is required.");
  }
  if (!task) {
    return invalid("Delegated task must be non-empty.");
  }
  if (task.length > MAX_TASK_CHARS) {
    return invalid(`Delegated task must be ${MAX_TASK_CHARS} characters or fewer.`);
  }
  if (request.metadata && Object.keys(request.metadata).length > 16) {
    return invalid("Delegation metadata may contain at most 16 entries.");
  }
  return {
    delegate,
    task,
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

function invalid(message: string): StructuredToolError {
  return { ok: false, summary: message, error: message, code: "INVALID_DELEGATION_REQUEST" };
}
