import type { Model, NonSystemMessage, TokenUsage, Tool } from "@/core";
import type { ExecutionErrorInfo } from "@/runtime/execution/types";

export type CompactionLevel = "turn" | "segment" | "phase" | "session";

export const CONTEXT_SUMMARY_SCHEMA_VERSION = 1;

export interface ContextSourceRange {
  firstMessageIndex: number;
  lastMessageIndex: number;
  firstTurnIndex: number;
  lastTurnIndex: number;
  firstMessageId?: string;
  lastMessageId?: string;
  firstTurnId?: string;
  lastTurnId?: string;
  sourceRevision?: number;
}

export interface StructuredContextSummary {
  objectives: string[];
  constraints: string[];
  decisions: Array<{ decision: string; reason?: string }>;
  progress: string[];
  results: string[];
  artifacts: string[];
  pending: string[];
}

export interface ContextModelSnapshot {
  model: string;
  provider?: string;
  configId?: string;
  configName?: string;
}

export interface ContextSummaryUsage extends TokenUsage {
  usageIncomplete?: boolean;
}

export interface CompactionNode {
  id: string;
  level: CompactionLevel;
  phaseId?: string;
  checkpoint: boolean;
  source: ContextSourceRange;
  childNodeIds: string[];
  summary: StructuredContextSummary;
  renderedText: string;
  estimatedTokens: number;
  summarySchemaVersion: number;
  policyVersion: string;
  generatedBy: ContextModelSnapshot;
  generationUsage: ContextSummaryUsage;
  createdAt: string;
}

export interface ContextPolicy {
  triggerRatio: number;
  targetRatio: number;
  safetyMarginTokens?: number;
  recentTurns: number;
  recentReserveTokens: number;
  activeTurnRecentBlocks: number;
  turnSummaryTargetTokens: number;
  segmentSourceTargetTokens: number;
  segmentSummaryTargetTokens: number;
  phaseSummaryTargetTokens: number;
  sessionSummaryTargetTokens: number;
  policyVersion: string;
}

export interface ContextBudget {
  inputBudget: number;
  triggerBudget: number;
  targetBudget: number;
  safetyMarginTokens: number;
}

export interface ContextSummaryRequest {
  level: CompactionLevel | "turn_checkpoint";
  sourceText: string;
  targetTokens: number;
  policyVersion: string;
  signal: AbortSignal;
  model?: Model;
}

export interface ContextSummaryResult {
  summary: StructuredContextSummary;
  renderedText: string;
  usage?: ContextSummaryUsage;
}

export interface ContextSummarizer {
  summarize(request: ContextSummaryRequest): Promise<ContextSummaryResult>;
}

export interface ContextManagerPrepareParams {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  model: Model;
  signal: AbortSignal;
  sources?: ContextSourceMessage[];
}

export interface ContextManagerPrepareResult {
  messages: NonSystemMessage[];
  nodes: CompactionNode[];
  frontierNodeIds: string[];
  policyVersion: string;
  summarySchemaVersion: number;
  sourceRevision?: number;
  usage: ContextSummaryUsage;
  estimatedTokens: number;
  compacted: boolean;
}

export interface ContextManager {
  /** Optional per-Agent switch used when a shared Branch manager spans model changes. */
  enabledForModel?(model: Model): boolean;
  prepare(params: ContextManagerPrepareParams): Promise<ContextManagerPrepareResult>;
}

export type ContextErrorCode =
  | "CONTEXT_WINDOW_UNCONFIGURED"
  | "CONTEXT_FIXED_BUDGET_EXCEEDED"
  | "CONTEXT_BLOCK_TOO_LARGE"
  | "CONTEXT_SUMMARY_FAILED"
  | "CONTEXT_SUMMARY_INVALID"
  | "CONTEXT_STATE_INVALID";

export class ContextError extends Error {
  constructor(
    readonly code: ContextErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ContextError";
  }

  toExecutionError(): ExecutionErrorInfo {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export interface ContextMessageBlock {
  start: number;
  end: number;
  messages: NonSystemMessage[];
  estimatedTokens: number;
  turnIndex: number;
  incomplete: boolean;
}

export interface ContextSourceMessage {
  messageId: string;
  turnId: string;
  turnIndex: number;
  phaseId?: string;
  phaseStatus?: "active" | "completed";
  sourceRevision?: number;
}
