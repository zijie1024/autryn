import type Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, Message, TokenUsage, Tool } from "@/core";

/**
 * 从 Autryn 消息中提取 system prompt。
 * Anthropic 将 system prompt 作为独立的顶层参数传入，而非放进 messages 数组。
 * 无 system 消息时返回 `undefined`。
 */
export function extractSystemPrompt(messages: Message[]): string | undefined {
  const systemMessages = messages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) return undefined;
  return systemMessages
    .flatMap((m) => m.content)
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n\n");
}

/**
 * 把 Autryn 消息转换为 Anthropic MessageParam 消息。
 * system 消息在此排除（由 extractSystemPrompt 单独处理）。
 */
export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      // system 消息在 Anthropic API 中是单独传递的。
      continue;
    }

    if (message.role === "user") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          // Anthropic 支持 base64 或 URL 两种图片来源；这里是 URL 形式。
          content.push({
            type: "image",
            source: {
              type: "url",
              url: part.image_url.url,
            },
          });
        }
      }
      result.push({ role: "user", content });
    } else if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "thinking") {
          // 多轮对话中 Anthropic 要求 thinking 块带合法签名。
          content.push({
            type: "thinking",
            thinking: part.thinking,
            signature: part.signature ?? "",
          });
        } else if (part.type === "tool_use") {
          content.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          });
        }
      }
      result.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      // Anthropic 以带 tool_result 内容块的 user 消息承载 tool 结果。
      const content: Anthropic.ToolResultBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "tool_result") {
          content.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
          });
        }
      }
      result.push({ role: "user", content });
    }
  }

  return result;
}

/**
 * 把 Anthropic API 响应解析为 Autryn AssistantMessage。
 */
export function parseAssistantMessage(response: Anthropic.Message, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = {
    role: "assistant",
    content: [],
    usage,
  };

  for (const block of response.content) {
    if (block.type === "text") {
      result.content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      // 保留签名，以便多轮对话时回传。
      result.content.push({
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature ? { signature: block.signature } : {}),
      });
    } else if (block.type === "tool_use") {
      result.content.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        // Anthropic SDK 把 tool 输入类型定为 `unknown`；Autryn 契约要求对象载荷
        //（API 响应中的 JSON 对象）。
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return result;
}

/**
 * 把 Autryn tools 转换为 Anthropic tool 定义。
 */
export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters.toJSONSchema() as Anthropic.Tool["input_schema"],
  }));
}
