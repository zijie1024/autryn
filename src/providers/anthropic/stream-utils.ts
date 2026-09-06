import type Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, AssistantMessageContent, TokenUsage } from "@/core";

/**
 * 流式传输中单个内容块的累积状态。
 * `type` 判别字段在块开始时确定，其余字段随 delta 到达逐步填充。
 */
type BlockState =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; partialJson: string };

/**
 * 把 Anthropic 流事件累积为逐步更完整的 {@link AssistantMessage} 快照。
 *
 * Anthropic 流式协议按顺序发出以下事件：
 * - `message_start` — 携带初始 usage（仅 input tokens）。
 * - `content_block_start` — 在指定 index 打开一个块（text、thinking 或 tool_use）。
 * - `content_block_delta` — 追加到当前块（text、thinking、input JSON 或 signature）。
 * - `content_block_stop` — 关闭该块。
 * - `message_delta` — 在最后一个事件上携带最终 usage（output tokens）。
 */
export class StreamAccumulator {
  private readonly blocks = new Map<number, BlockState>();
  private inputTokens = 0;
  private outputTokens = 0;
  private hasFinalUsage = false;

  push(event: Anthropic.RawMessageStreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.inputTokens = event.message.usage.input_tokens ?? 0;
        this.outputTokens = event.message.usage.output_tokens ?? 0;
        return;
      case "content_block_start":
        this._handleBlockStart(event);
        return;
      case "content_block_delta":
        this._handleBlockDelta(event);
        return;
      case "message_delta":
        this._handleMessageDelta(event);
        return;
      // content_block_stop 与 message_stop 不携带我们需要的数据。
      default:
        return;
    }
  }

  snapshot(): AssistantMessage {
    const content: AssistantMessageContent = [];
    // 按 index 保持 Anthropic 的块顺序。
    const ordered = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, block] of ordered) {
      const item = blockToContent(block);
      if (item) content.push(item);
    }

    return {
      role: "assistant",
      content,
      usage: this.hasFinalUsage ? this._buildUsage() : undefined,
      ...(this.hasFinalUsage ? {} : { streaming: true }),
    };
  }

  private _handleBlockStart(event: Anthropic.RawContentBlockStartEvent): void {
    const { index, content_block } = event;
    if (content_block.type === "text") {
      this.blocks.set(index, { type: "text", text: content_block.text });
    } else if (content_block.type === "thinking") {
      this.blocks.set(index, {
        type: "thinking",
        thinking: content_block.thinking,
        ...(content_block.signature ? { signature: content_block.signature } : {}),
      });
    } else if (content_block.type === "tool_use") {
      this.blocks.set(index, {
        type: "tool_use",
        id: content_block.id,
        name: content_block.name,
        partialJson: "",
      });
    }
  }

  private _handleBlockDelta(event: Anthropic.RawContentBlockDeltaEvent): void {
    const block = this.blocks.get(event.index);
    if (!block) return;
    const delta = event.delta;
    if (delta.type === "text_delta" && block.type === "text") {
      block.text += delta.text;
    } else if (delta.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking;
    } else if (delta.type === "signature_delta" && block.type === "thinking") {
      block.signature = delta.signature;
    } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
      block.partialJson += delta.partial_json;
    }
  }

  private _handleMessageDelta(event: Anthropic.RawMessageDeltaEvent): void {
    // 最终 usage —— 该事件上的 output tokens 是累计值。
    if (event.usage.output_tokens != null) {
      this.outputTokens = event.usage.output_tokens;
    }
    if (event.usage.input_tokens != null) {
      this.inputTokens = event.usage.input_tokens;
    }
    this.hasFinalUsage = true;
  }

  private _buildUsage(): TokenUsage {
    return {
      promptTokens: this.inputTokens,
      completionTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
    };
  }
}

/**
 * 把单个累积块转为其 {@link AssistantMessageContent} 表示；
 * 当块尚无可见载荷（如 text 块还没收到任何 delta）时返回 null。
 */
function blockToContent(block: BlockState): AssistantMessageContent[number] | null {
  if (block.type === "text") {
    return block.text ? { type: "text", text: block.text } : null;
  }
  if (block.type === "thinking") {
    return {
      type: "thinking",
      thinking: block.thinking,
      // 保留签名，以便多轮对话时回传。
      ...(block.signature ? { signature: block.signature } : {}),
    };
  }
  // 其余即 tool_use。
  return { type: "tool_use", id: block.id, name: block.name, input: parseToolInput(block.partialJson) };
}

function parseToolInput(partialJson: string): Record<string, unknown> {
  if (!partialJson) return {};
  try {
    return JSON.parse(partialJson);
  } catch {
    // input JSON 尚未完成——先产出空输入，直到它结束。
    return {};
  }
}
