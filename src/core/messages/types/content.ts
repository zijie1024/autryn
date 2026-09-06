/**
 * 消息中的纯文本段。
 */
export interface TextContent {
  type: "text";
  text: string;
}

/**
 * 通过 URL 引用的图片，用于多模态用户输入。
 */
export interface ImageURLContent {
  type: "image_url";
  image_url: {
    url: string;
    /**
     * 可选的视觉细节级别，具体由 provider 决定如何处理：
     * - `auto` — 让模型自行权衡分辨率与开销。
     * - `high` / `low` — 偏向更多或更少的视觉细节。
     */
    detail?: "auto" | "high" | "low";
  };
}

/**
 * 模型推理或思维链文本（当 provider 暴露时）。
 */
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /**
   * provider 下发的校验数据（如 Anthropic 的 thinking signature）。
   * 当该块回传给同一 provider 时，必须原样往返传递，不能改动。
   * 它属于 provider 元数据而非模型内容：其他 provider 会忽略它，
   * 拷贝到其他上下文的 transcript 不应依赖该字段。
   */
  signature?: string;
}

/**
 * Assistant 发起的带结构化参数的 tool 调用。
 */
export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  /** 本次调用的稳定标识，用于与 {@link ToolResultContent} 关联。 */
  id: string;
  /** 模型选中的已注册 tool 名称。 */
  name: string;
  /** 传给 tool 的 JSON 可序列化参数。 */
  input: T;
}

/**
 * tool 执行结果，通过 id 关联回先前的 {@link ToolUseContent}。
 */
export interface ToolResultContent {
  type: "tool_result";
  /** 与所响应调用的 {@link ToolUseContent.id} 一致。 */
  tool_use_id: string;
  /** tool runtime 返回的、人机可读的结果（通常是 JSON 字符串）。 */
  content: string;
}

/** system 消息允许的内容（仅文本）。 */
export type SystemMessageContent = TextContent[];

/** user 消息允许的内容（文本和/或图片）。 */
export type UserMessageContent = (TextContent | ImageURLContent)[];

/** assistant 消息允许的内容。 */
export type AssistantMessageContent = (TextContent | ThinkingContent | ToolUseContent)[];

/** tool 角色消息允许的内容。 */
export type ToolMessageContent = ToolResultContent[];
