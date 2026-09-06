import type { ContextBudget, ContextPolicy } from "./types";

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  triggerRatio: 0.8,
  targetRatio: 0.65,
  recentTurns: 3,
  recentReserveTokens: 4096,
  activeTurnRecentBlocks: 4,
  turnSummaryTargetTokens: 512,
  segmentSourceTargetTokens: 8192,
  segmentSummaryTargetTokens: 1024,
  phaseSummaryTargetTokens: 1536,
  sessionSummaryTargetTokens: 2048,
  policyVersion: "context-v1",
};

export function resolveContextPolicy(policy: Partial<ContextPolicy> = {}): ContextPolicy {
  return { ...DEFAULT_CONTEXT_POLICY, ...policy };
}

export function calculateContextBudget(input: {
  contextWindowTokens: number;
  maxOutputTokens: number;
  policy: ContextPolicy;
}): ContextBudget {
  const safetyMarginTokens =
    input.policy.safetyMarginTokens ?? Math.max(1024, Math.floor(input.contextWindowTokens * 0.02));
  const inputBudget = input.contextWindowTokens - input.maxOutputTokens - safetyMarginTokens;
  return {
    inputBudget,
    triggerBudget: Math.floor(inputBudget * input.policy.triggerRatio),
    targetBudget: Math.floor(inputBudget * input.policy.targetRatio),
    safetyMarginTokens,
  };
}
