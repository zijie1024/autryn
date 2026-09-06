import type {
  AssistantMessage,
  ModelContext,
  RuntimeToolOutcome,
  StructuredToolError,
  ToolDisposition,
} from "@/core";
import type { AgentId, ExecutionBranchSnapshot, ExecutionSnapshot, HandoffRecord } from "@/runtime/execution/types";
import type { ToolInvocation } from "@/runtime/tools/tool-executor";

import type { AgentContext } from "../agent/agent";

/**
 * 让 middleware 观察并/或修改一次 {@link Agent} 运行的生命周期钩子。
 *
 * 钩子按 middleware 数组顺序**串行**调用，每个钩子拿到 agent loop 使用的同一个 `context` 对象。
 *
 * 若钩子返回真值的 `Partial<AgentContext>`，会通过 `Object.assign(context, result)`
 * 合并进共享 context；返回 `null`/`undefined`/`void`（或其他假值）表示「不变更」。
 *
 * 所有钩子都是可选的。
 */
export type BeforeModelParams = {
  modelContext: ModelContext;
  agentContext: AgentContext;
};

export type AfterModelParams = {
  agentContext: AgentContext;
  message: AssistantMessage;
};

export type BeforeAgentRunParams = {
  agentContext: AgentContext;
};

export type AfterAgentRunParams = {
  agentContext: AgentContext;
};

export type BeforeAgentStepParams = {
  agentContext: AgentContext;
  /** 当前 step 序号（从 1 开始）。 */
  step: number;
};

export type AfterAgentStepParams = {
  agentContext: AgentContext;
  /** 当前 step 序号（从 1 开始）。 */
  step: number;
};

export type BeforeToolUseParams = {
  agentContext: AgentContext;
  invocation: Readonly<ToolInvocation>;
  /** 请求该 tool 的 execution 的仅含身份信息快照；agent 自有的调用始终会设置它。 */
  execution?: ExecutionSnapshot;
  /** 该 execution 被取消、超时或停止时中止；agent 自有的调用始终会设置它。 */
  signal?: AbortSignal;
};

export type AfterToolUseParams = {
  agentContext: AgentContext;
  invocation: Readonly<ToolInvocation>;
  disposition: ToolDisposition;
  result: RuntimeToolOutcome;
};

export type BeforeHandoffParams = {
  agentContext: AgentContext;
  source: Readonly<ExecutionSnapshot>;
  branch: Readonly<ExecutionBranchSnapshot>;
  targetAgentId: AgentId;
  input: Record<string, unknown>;
};

export type AfterHandoffParams = {
  agentContext: AgentContext;
  record: Readonly<HandoffRecord>;
  source: Readonly<ExecutionSnapshot>;
  branch: Readonly<ExecutionBranchSnapshot>;
};

export type BeforeToolUseResult =
  | Partial<AgentContext>
  | { readonly action: "continue"; readonly input?: Record<string, unknown> }
  | { readonly action: "reject"; readonly result: StructuredToolError }
  | null
  | undefined
  | void;

export type BeforeHandoffResult =
  | { readonly action: "continue"; readonly input?: Record<string, unknown> }
  | { readonly action: "reject"; readonly result: StructuredToolError }
  | null
  | undefined
  | void;

export type MiddlewareDryRunPolicy =
  | { mode: "compatible" }
  | { mode: "skip" }
  | { mode: "forbidden"; reason: string };

export interface AgentMiddleware {
  name?: string;
  dryRun?: MiddlewareDryRunPolicy;
  /** 调用 model 前立即执行；返回的 `Partial<ModelContext>` 会合并进 `modelContext`。 */
  beforeModel?: (params: BeforeModelParams) => Promise<Partial<ModelContext> | null | undefined | void>;

  /** 调用 model 后立即执行；返回的 `Partial<AssistantMessage>` 会合并进 `message`。 */
  afterModel?: (params: AfterModelParams) => Promise<Partial<AssistantMessage> | null | undefined | void>;

  /** user 消息追加后、第一步开始前执行一次；返回的 `Partial<AgentContext>` 会合并进共享 context。 */
  beforeAgentRun?: (params: BeforeAgentRunParams) => Promise<Partial<AgentContext> | null | undefined | void>;
  /**
   * agent 因未产生 tool 调用而即将停止时执行一次。
   *
   * 注意：若 agent 抛错（如达到最大 step 数），不会调用本钩子。
   */
  afterAgentRun?: (params: AfterAgentRunParams) => Promise<Partial<AgentContext> | null | undefined | void>;

  /** 每个 step 开始、调用 model 前执行；返回的 `Partial<AgentContext>` 会合并进共享 context。 */
  beforeAgentStep?: (params: BeforeAgentStepParams) => Promise<Partial<AgentContext> | null | undefined | void>;
  /** 每个 step 结束、该 step 的 tool 调用全部完成后执行（如有）。 */
  afterAgentStep?: (params: AfterAgentStepParams) => Promise<Partial<AgentContext> | null | undefined | void>;

  /** 调用 tool 前立即执行；返回带 `__skip` 的指令可绕过 tool 执行。 */
  beforeToolUse?: (params: BeforeToolUseParams) => Promise<BeforeToolUseResult>;
  /** tool 调用返回后立即执行；返回的 `Partial<AgentContext>` 会合并进共享 context。 */
  afterToolUse?: (params: AfterToolUseParams) => Promise<Partial<AgentContext> | null | undefined | void>;

  /** Handoff 提交前执行；可缩减业务输入或拒绝本次控制权转移。 */
  beforeHandoff?: (params: BeforeHandoffParams) => Promise<BeforeHandoffResult>;
  /** Handoff 提交后执行；用于观察已经建立的 predecessor/successor 关系。 */
  afterHandoff?: (params: AfterHandoffParams) => Promise<void>;
}
