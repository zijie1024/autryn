import type { ExecutionBranchSnapshot, ExecutionSnapshot, ExecutionTreeSnapshot, ExecutionUsage } from "@/runtime/execution/types";

export function emptyUsage(): ExecutionUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageIncomplete: false };
}

export function aggregateTree(
  rootExecutionId: string,
  executions: ExecutionSnapshot[],
  branches: ExecutionBranchSnapshot[] = [],
): ExecutionTreeSnapshot {
  const usage = emptyUsage();
  for (const execution of executions) {
    usage.promptTokens += execution.usage.promptTokens;
    usage.completionTokens += execution.usage.completionTokens;
    usage.totalTokens += execution.usage.totalTokens;
    usage.usageIncomplete ||= execution.usage.usageIncomplete;
  }
  return {
    rootExecutionId,
    rootBranchId: branches.find((branch) => !branch.parentBranchId)?.id ?? rootExecutionId,
    executions: executions.map((execution) => structuredClone(execution)),
    branches: branches.map((branch) => structuredClone(branch)),
    usage,
  };
}
