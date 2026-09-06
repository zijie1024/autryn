import type { ChatCompletionContentPart, ChatCompletionTool } from "openai/resources";

import type { AssistantMessage, Message, TokenUsage, Tool } from "@/core";

import type {
  OpenAIAssistantMessageParam,
  OpenAIChatCompletionMessage,
  OpenAIChatCompletionMessageParam,
} from "./types";

/** 把 Autryn 消息转换为 OpenAI ChatCompletionMessageParam 消息。 */
export function convertToOpenAIMessages(messages: Message[]): OpenAIChatCompletionMessageParam[] {
  const openaiMessages: OpenAIChatCompletionMessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      openaiMessages.push(message);
    } else if (message.role === "assistant") {
      const assistantMessage: OpenAIAssistantMessageParam = {
        role: "assistant",
        content: [],
      };
      for (const content of message.content) {
        if (content.type === "thinking") {
          assistantMessage.reasoning_content = content.thinking;
        } else if (content.type === "tool_use") {
          if (!assistantMessage.tool_calls) {
            assistantMessage.tool_calls = [];
          }
          assistantMessage.tool_calls.push({
            type: "function",
            id: content.id,
            function: {
              name: content.name,
              arguments: JSON.stringify(content.input),
            },
          });
        } else {
          (assistantMessage.content as ChatCompletionContentPart[]).push(content);
        }
      }
      if (assistantMessage.content?.length === 0) {
        assistantMessage.content = "";
      }
      openaiMessages.push(assistantMessage);
    } else if (message.role === "tool") {
      for (const content of message.content) {
        if (content.type === "tool_result") {
          openaiMessages.push({
            role: "tool",
            tool_call_id: content.tool_use_id,
            content: content.content,
          });
        }
      }
    }
  }
  return openaiMessages;
}

/** 把 OpenAI ChatCompletionMessage 解析为 assistant 消息。 */
export function parseAssistantMessage(message: OpenAIChatCompletionMessage, usage?: TokenUsage): AssistantMessage {
  const result: AssistantMessage = {
    role: "assistant",
    content: [],
    usage,
  };
  if (typeof message.reasoning_content === "string") {
    result.content.push({ type: "thinking", thinking: message.reasoning_content });
  }
  if (typeof message.content === "string") {
    result.content.push({ type: "text", text: message.content });
  }
  if (message.tool_calls) {
    for (const tool_call of message.tool_calls) {
      if (tool_call.type === "function") {
        // 与流式累加器保持一致：畸形/不完整的 arguments JSON
        // 回退为空输入，而不是让整个 invoke 失败。
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tool_call.function.arguments);
        } catch {
          // 保持上面的空对象兜底
        }
        result.content.push({
          type: "tool_use",
          id: tool_call.id,
          name: tool_call.function.name,
          input,
        });
      }
    }
  }
  return result;
}

/** 把 Autryn tools 转换为 OpenAI ChatCompletionTool。 */
export function convertToOpenAITools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters.toJSONSchema() },
  }));
}
