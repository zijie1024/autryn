import type { z } from "zod";

import type {
  AssistantMessage,
  ExecutionMode,
  Model,
  NonSystemMessage,
  RuntimeToolOutcome,
  Tool,
  ToolEffect,
  ToolDisposition,
  ToolPreview,
} from "@/core";
import type { ContextManager } from "@/runtime/context";
import type { AgentEvent } from "@/runtime/events/agent-event";
import type { AgentExecution } from "@/runtime/execution/agent-execution";
import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import type { SkillFrontmatter } from "../skills";

export type ExecutionStatus =
  | "created"
  | "queued"
  | "running"
  | "handed_off"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "limit_exceeded";

export type TerminalExecutionStatus = "completed" | "failed" | "cancelled" | "timed_out" | "limit_exceeded";
export type ExecutionTerminalStatus = TerminalExecutionStatus | "handed_off";
export type BranchStatus = "running" | TerminalExecutionStatus;
export type AgentId = string;
export type ExecutionBranchId = string;

export type ExecutionErrorCode =
  | "DELEGATION_NOT_ALLOWED"
  | "DELEGATE_NOT_FOUND"
  | "DELEGATE_FACTORY_FAILED"
  | "DEPTH_LIMIT_EXCEEDED"
  | "RECURSION_NOT_ALLOWED"
  | "CHILD_LIMIT_EXCEEDED"
  | "TREE_LIMIT_EXCEEDED"
  | "CONCURRENCY_LIMIT_EXCEEDED"
  | "MAX_STEPS_EXCEEDED"
  | "TOKEN_LIMIT_EXCEEDED"
  | "EXECUTION_TIMEOUT"
  | "EXECUTION_CANCELLED"
  | "MODEL_FAILED"
  | "MIDDLEWARE_FAILED"
  | "CONTEXT_WINDOW_UNCONFIGURED"
  | "CONTEXT_FIXED_BUDGET_EXCEEDED"
  | "CONTEXT_BLOCK_TOO_LARGE"
  | "CONTEXT_SUMMARY_FAILED"
  | "CONTEXT_SUMMARY_INVALID"
  | "CONTEXT_STATE_INVALID"
  | "INTERNAL_ERROR"
  | "INVALID_DELEGATION_REQUEST";
export type HandoffErrorCode =
  | "HANDOFF_NOT_ALLOWED"
  | "HANDOFF_TARGET_NOT_FOUND"
  | "HANDOFF_INPUT_INVALID"
  | "HANDOFF_MUST_BE_EXCLUSIVE"
  | "HANDOFF_TARGET_MISMATCH"
  | "HANDOFF_TARGET_FACTORY_FAILED"
  | "HANDOFF_CONTEXT_INVALID"
  | "HANDOFF_LIMIT_EXCEEDED"
  | "HANDOFF_TARGET_VISIT_LIMIT_EXCEEDED"
  | "HANDOFF_COMMIT_FAILED";

export type DryRunErrorCode =
  | "TOOL_EFFECT_MISSING"
  | "TOOL_EFFECT_INVALID"
  | "DRY_RUN_UNKNOWN_EFFECT"
  | "DRY_RUN_PREVIEW_UNAVAILABLE"
  | "DRY_RUN_PREVIEW_FAILED"
  | "DRY_RUN_PREVIEW_INVALID"
  | "DRY_RUN_MODE_ESCALATION"
  | "DRY_RUN_REPORT_INVALID";

export interface ExecutionErrorInfo {
  code: ExecutionErrorCode;
  message: string;
  retryable: boolean;
}

export interface ExecutionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageIncomplete: boolean;
}

export interface ExecutionSnapshot {
  id: string;
  parentExecutionId?: string;
  rootExecutionId: string;
  branchId: ExecutionBranchId;
  agentId: AgentId;
  agentName?: string;
  delegateName?: string;
  depth: number;
  handoffIndex: number;
  predecessorExecutionId?: string;
  successorExecutionId?: string;
  mode: ExecutionMode;
  status: ExecutionStatus;
  activity?: "active" | "waiting_for_children" | "waiting_for_permit";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  steps: number;
  usage: ExecutionUsage;
  error?: ExecutionErrorInfo;
}

export interface ExecutionTreeSnapshot {
  rootExecutionId: string;
  rootBranchId: ExecutionBranchId;
  executions: ExecutionSnapshot[];
  branches: ExecutionBranchSnapshot[];
  usage: ExecutionUsage;
}

export interface ExecutionResult {
  executionId: string;
  parentExecutionId?: string;
  rootExecutionId: string;
  branchId: ExecutionBranchId;
  agentId: AgentId;
  mode: ExecutionMode;
  status: ExecutionTerminalStatus;
  output?: {
    text: string;
    message: AssistantMessage;
  };
  steps: number;
  usage: ExecutionUsage;
  durationMs: number;
  error?: ExecutionErrorInfo;
}

export interface HandoffRecord {
  sourceExecutionId: string;
  successorExecutionId: string;
  sourceAgentId: AgentId;
  targetAgentId: AgentId;
  sequence: number;
  committedAt: number;
}

export interface ExecutionBranchSnapshot {
  id: ExecutionBranchId;
  rootExecutionId: string;
  parentBranchId?: ExecutionBranchId;
  initialExecutionId: string;
  currentExecutionId: string;
  executionIds: string[];
  handoffCount: number;
  status: BranchStatus;
  mode: ExecutionMode;
  usage: ExecutionUsage;
  handoffs: HandoffRecord[];
}

export interface ExecutionBranchResult {
  branchId: ExecutionBranchId;
  executionId: string;
  agentId: AgentId;
  parentExecutionId?: string;
  initialExecutionId: string;
  finalExecutionId: string;
  initialAgentId: AgentId;
  finalAgentId: AgentId;
  rootExecutionId: string;
  status: TerminalExecutionStatus;
  mode: ExecutionMode;
  output?: ExecutionResult["output"];
  handoffs: HandoffRecord[];
  usage: ExecutionUsage;
  steps: number;
  durationMs: number;
  error?: ExecutionErrorInfo;
  dryRunReport?: DryRunReport;
}

export interface ExecutionEventBase {
  executionId: string;
  parentExecutionId?: string;
  rootExecutionId: string;
  branchId: ExecutionBranchId;
  agentId: AgentId;
  depth: number;
  sequence: number;
  timestamp: number;
}

export type ExecutionLifecycleEvent = ExecutionEventBase & {
  type: "lifecycle";
  status: ExecutionStatus;
};

export type HandoffEvent = ExecutionEventBase &
  (
    | {
        type: "handoff";
        status: "requested";
        sourceExecutionId: string;
        targetAgentId: AgentId;
      }
    | {
        type: "handoff";
        status: "rejected";
        sourceExecutionId: string;
        targetAgentId: AgentId;
        error: ExecutionErrorInfo;
      }
    | {
        type: "handoff";
        status: "committed";
        sourceExecutionId: string;
        targetAgentId: AgentId;
        successorExecutionId: string;
        record: HandoffRecord;
      }
  );

export type HandoffEventPayload = HandoffEvent extends infer Event
  ? Event extends HandoffEvent
    ? Omit<Event, keyof ExecutionEventBase>
    : never
  : never;

export type ToolRuntimeEvent = ExecutionEventBase & {
  type: "tool";
  status: "started" | "previewed" | "executed" | "blocked" | "rejected";
  mode: ExecutionMode;
  effect: ToolEffect;
  toolCallId: string;
  toolName: string;
  summary?: string;
  error?: ExecutionErrorInfo;
};

export type ExecutionAgentEvent = ExecutionEventBase & AgentEvent;

export type ExecutionEvent = ExecutionLifecycleEvent | HandoffEvent | ToolRuntimeEvent | ExecutionAgentEvent;

export type RuntimeEvent = {
  type: "execution";
  execution: ExecutionSnapshot;
} | {
  type: "model_call";
  executionId: string;
  rootExecutionId: string;
  branchId: ExecutionBranchId;
  agentId: AgentId;
  model: string;
  timestamp: number;
};

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface DelegationLimits {
  maxDepth: number;
  maxChildrenPerExecution: number;
  maxExecutionsPerTree: number;
  maxConcurrentPerParent: number;
  maxConcurrentPerTree: number;
  maxConcurrentDelegatedExecutions: number;
  childTimeoutMs: number;
  childMaxSteps: number;
  maxTokensPerTree: number;
  maxStepsPerBranch: number;
  maxHandoffsPerBranch: number;
  maxVisitsPerTargetPerBranch: number;
}

export const DEFAULT_DELEGATION_LIMITS: DelegationLimits = {
  maxDepth: 3,
  maxChildrenPerExecution: 8,
  maxExecutionsPerTree: 32,
  maxConcurrentPerParent: 4,
  maxConcurrentPerTree: 8,
  maxConcurrentDelegatedExecutions: 16,
  childTimeoutMs: 300_000,
  childMaxSteps: 50,
  maxTokensPerTree: Number.POSITIVE_INFINITY,
  maxStepsPerBranch: 100,
  maxHandoffsPerBranch: 8,
  maxVisitsPerTargetPerBranch: 2,
};

export type ChildToolPolicy =
  | { mode: "none" }
  | { mode: "configured" }
  | { mode: "explicit"; tools: Tool[] }
  | { mode: "inherit"; allow?: string[]; deny?: string[] };

export type ChildSkillPolicy =
  | { mode: "none" }
  | { mode: "explicit"; skills: SkillFrontmatter[] }
  | { mode: "inherit"; allow?: string[] };

export interface DelegatePolicy {
  model?: Model;
  tools?: ChildToolPolicy;
  skills?: ChildSkillPolicy;
  delegates?: DelegateDefinition[];
  maxSteps?: number;
  timeoutMs?: number;
}

export interface AgentConfiguration {
  id?: AgentId;
  name?: string;
  model: Model;
  prompt: string;
  messages?: NonSystemMessage[];
  tools?: Tool[];
  skills?: SkillFrontmatter[];
  middlewares?: AgentMiddleware[];
  maxSteps?: number;
  delegates?: DelegateDefinition[];
  handoffs?: HandoffDefinition[];
  contextManager?: ContextManager;
}

export interface AgentRunOptions {
  mode?: ExecutionMode;
}

export interface DelegateCreationContext {
  runtime: unknown;
  parent: Readonly<ExecutionSnapshot>;
  parentModel: Model;
  task: string;
}

export interface DelegateDefinition {
  name: string;
  description: string;
  create: (context: DelegateCreationContext) => AgentConfiguration | Promise<AgentConfiguration>;
  policy?: DelegatePolicy;
}

export interface DelegationRequest {
  delegate: string;
  task: string;
  timeoutMs?: number;
  metadata?: Record<string, string>;
}

export type DelegationStartResult =
  | { accepted: true; branch: ExecutionBranchSnapshot; execution: AgentExecution }
  | { accepted: false; error: ExecutionErrorInfo };

export type DelegationResult =
  | { accepted: true; execution: ExecutionBranchResult }
  | { accepted: false; error: ExecutionErrorInfo };

export interface HandoffCreationContext<I extends Record<string, unknown> = Record<string, unknown>> {
  runtime: unknown;
  source: Readonly<ExecutionSnapshot>;
  branch: Readonly<ExecutionBranchSnapshot>;
  input: I;
  model: Model;
}

export type HandoffContextPolicy =
  | { mode: "continue" }
  | {
      mode: "filter";
      filter(input: {
        source: Readonly<ExecutionSnapshot>;
        branch: Readonly<ExecutionBranchSnapshot>;
        messages: readonly NonSystemMessage[];
      }): NonSystemMessage[] | Promise<NonSystemMessage[]>;
    };

export interface HandoffDefinition<I extends Record<string, unknown> = Record<string, unknown>> {
  target: AgentId;
  description: string;
  input: z.ZodSchema<I>;
  create: (context: HandoffCreationContext<I>) => AgentConfiguration | Promise<AgentConfiguration>;
  context?: HandoffContextPolicy;
}

export interface DryRunEntry {
  executionId: string;
  branchId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  effect: ToolEffect;
  disposition: ToolDisposition;
  summary: string;
  preview?: ToolPreview;
  error?: { code: string; message: string };
  timestamp: string;
}

export interface DryRunReport {
  runId: string;
  rootExecutionId: string;
  mode: "dry_run";
  status: "completed" | "partial" | "failed" | "cancelled" | "timed_out" | "limit_exceeded";
  startedAt: string;
  finishedAt: string;
  entries: DryRunEntry[];
  summary: {
    executedReads: number;
    executedEphemeral: number;
    interactions: number;
    controlOperations: number;
    previews: number;
    noChanges: number;
    blocked: number;
    indeterminate: number;
  };
}

export interface ToolExecutionRecord {
  outcome: RuntimeToolOutcome;
  entry?: DryRunEntry;
}
