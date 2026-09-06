import type { AssistantMessage, AssistantMessageContent, TokenUsage } from "@/core";

import { getReasoningContent, type OpenAIChatCompletionChunk } from "./types";

export function toTokenUsage(usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

export class StreamAccumulator {
  private reasoningContent = "";
  private textContent = "";
  private toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
  private usage: TokenUsage | undefined;

  push(chunk: OpenAIChatCompletionChunk): void {
    const delta = chunk.choices[0]?.delta;

    if (delta) {
      // 推理/thinking 内容
      const reasoning = getReasoningContent(delta);
      if (reasoning) {
        this.reasoningContent += reasoning;
      }

      // 文本内容
      if (typeof delta.content === "string") {
        this.textContent += delta.content;
      }

      // tool 调用
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let entry = this.toolCalls.get(tc.index);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
            this.toolCalls.set(tc.index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }

    // usage 在最后一个 chunk 上到达（此时 choices 为空）
    if (chunk.usage) {
      this.usage = toTokenUsage(chunk.usage);
    }
  }

  snapshot(): AssistantMessage {
    const content: AssistantMessageContent = [];

    if (this.reasoningContent) {
      content.push({ type: "thinking", thinking: this.reasoningContent });
    }
    if (this.textContent) {
      content.push({ type: "text", text: this.textContent });
    }

    // 按 index 排序以保持顺序
    const sorted = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    const isFinal = this.usage !== undefined;
    for (const [, tc] of sorted) {
      let input: Record<string, unknown> = {};
      let parsed = false;
      try {
        input = JSON.parse(tc.arguments);
        parsed = true;
      } catch {
        // arguments JSON 仍在流式传输中——继续等待
      }
      // 流式（非最终快照）阶段有意先不发 tool_use，直到其 arguments 解析成功，
      // 这样下游（如 agent progress 事件）不会观察到半成品载荷；
      // 最终快照则回退到尽力而为的空对象，以保持既有契约。
      if (!parsed && !isFinal) continue;
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    return {
      role: "assistant",
      content,
      usage: this.usage,
      ...(this.usage ? {} : { streaming: true }),
    };
  }
}
