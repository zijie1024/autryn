import type { AssistantMessage, ToolMessage } from "@/core";
import type { CompactionLevel } from "@/runtime/context/types";
import type { ExecutionErrorInfo } from "@/runtime/execution/types";

/** {@link AgentEvent.type} 的判别值。 */
export type AgentEventType = "message" | "progress" | "context";

/** {@link AgentProgressEvent.subtype} 的判别值。 */
export type AgentProgressSubtype = "thinking" | "tool";

/**
 * 每个完成的 assistant 回合、以及每个完成的 tool 结果各触发一次。
 * 该类型事件上 `message.streaming` 始终为缺省/`false`。
 */
export interface AgentMessageEvent {
  type: "message";
  message: AssistantMessage | ToolMessage;
}

/**
 * 当当前 model 快照只含文本和/或 thinking 内容（即还没有任何 `tool_use`）时触发。
 */
export interface AgentProgressThinkingEvent {
  type: "progress";
  subtype: "thinking";
}

/**
 * 当当前 model 快照包含至少一个 `tool_use` 时触发。
 * 载荷反映快照中**最后**一个 `tool_use`；其 `input` 可能是部分/进行中的 JSON 值。
 */
export interface AgentProgressToolEvent {
  type: "progress";
  subtype: "tool";
  /** 当前快照中最新的 tool_use 名称。 */
  name: string;
  /** 该 tool_use 当前的（可能是部分的）输入载荷。 */
  input: unknown;
}

/** 所有 progress 事件的联合；按 `subtype` 收窄。 */
export type AgentProgressEvent = AgentProgressThinkingEvent | AgentProgressToolEvent;

export interface AgentContextEvent {
  type: "context";
  status: "started" | "completed" | "failed";
  level?: CompactionLevel | "turn_checkpoint";
  sourceTokens?: number;
  resultTokens?: number;
  nodeIds?: string[];
  error?: ExecutionErrorInfo;
}

/** 所有 agent 事件的联合；先按 `type` 再按 `subtype` 收窄。 */
export type AgentEvent = AgentMessageEvent | AgentProgressEvent | AgentContextEvent;
