import type { AssistantMessageContent, SystemMessageContent, ToolMessageContent, UserMessageContent } from "./content";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 发给 model 的 system 提示或策略文本。
 */
export interface SystemMessage {
  role: "system";
  /** 有序的 system 文本段，见 {@link SystemMessageContent}。 */
  content: SystemMessageContent;
}

/**
 * 终端用户的一轮输入，可包含图片。
 */
export interface UserMessage {
  role: "user";
  /** 文本和/或图片段，见 {@link UserMessageContent}。 */
  content: UserMessageContent;
}

/**
 * model 的回复，可包含文本、thinking 块或 tool 调用。
 */
export interface AssistantMessage {
  role: "assistant";
  /** 文本、可选推理内容以及/或 tool 调用，见 {@link AssistantMessageContent}。 */
  content: AssistantMessageContent;
  /** provider 报告的产生该消息的请求 token 用量（如有）。 */
  usage?: TokenUsage;
  /** 仅当消息仍在流式产出时为 `true`；完成后该字段不出现。 */
  streaming?: boolean;
}

/**
 * tool 执行的结果，通常在 assistant 的 tool 调用之后发送。
 */
export interface ToolMessage {
  role: "tool";
  /** tool 执行结果，每个都引用其来源 tool 调用 id，见 {@link ToolMessageContent}。 */
  content: ToolMessageContent;
}

/** 非 system 的消息。 */
export type NonSystemMessage = UserMessage | AssistantMessage | ToolMessage;

/** 对话 transcript 中支持的任何聊天消息。 */
export type Message = SystemMessage | NonSystemMessage;
