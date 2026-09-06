import type { Message, ModelContext, NonSystemMessage, Tool } from "@/core";

const messageOverhead = 16;
const contentOverhead = 8;
const toolOverhead = 48;
const safetyMultiplier = 1.1;

export class TokenEstimator {
  estimateModelContext(context: Pick<ModelContext, "prompt" | "messages" | "tools">): number {
    return this.withSafety(
      this.estimateText(context.prompt) + this.estimateMessages(context.messages) + this.estimateTools(context.tools),
    );
  }

  estimateMessages(messages: readonly Message[] | readonly NonSystemMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateMessage(message), 0);
  }

  estimateMessage(message: Message | NonSystemMessage): number {
    const roleCost = this.estimateText(message.role);
    const contentCost = message.content.reduce((total, content) => {
      if (content.type === "text") return total + contentOverhead + this.estimateText(content.text);
      if (content.type === "image_url")
        return total + contentOverhead + (content.image_url.detail === "high" ? 1700 : 900);
      if (content.type === "thinking") return total + contentOverhead + this.estimateText(content.thinking);
      if (content.type === "tool_use") return total + contentOverhead + this.estimateJson(content);
      return total + contentOverhead + this.estimateText(content.content);
    }, 0);
    return messageOverhead + roleCost + contentCost;
  }

  estimateTools(tools?: readonly Tool[]): number {
    if (!tools) return 0;
    return tools.reduce(
      (total, tool) =>
        total +
        toolOverhead +
        this.estimateText(tool.name) +
        this.estimateText(tool.description) +
        this.estimateToolSchema(tool),
      0,
    );
  }

  estimateText(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    let ascii = 0;
    let other = 0;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af)
      ) {
        cjk++;
      } else if (code <= 0x7f) {
        ascii++;
      } else {
        other++;
      }
    }
    const codeLike = /[{}[\]()/\\._-]|```|\b(import|export|function|class|const|let|type|interface)\b/.test(text);
    const asciiDivisor = codeLike ? 2.5 : 3.6;
    return Math.ceil(cjk + other * 0.75 + ascii / asciiDivisor);
  }

  estimateJson(value: unknown): number {
    return this.estimateText(JSON.stringify(value));
  }

  withSafety(tokens: number): number {
    return Math.ceil(tokens * safetyMultiplier);
  }

  private estimateToolSchema(tool: Tool): number {
    const parameters = tool.parameters as { toJSONSchema?: () => unknown } | undefined;
    if (typeof parameters?.toJSONSchema === "function") {
      return this.estimateJson(parameters.toJSONSchema());
    }
    return this.estimateJson(tool.parameters);
  }
}
