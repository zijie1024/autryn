import type { AssistantMessage, NonSystemMessage } from "@/core";

export interface TokenUsageSummary {
  latestInputTokens: number;
  /** 仅当前进程的累计 token；跨运行不持久化。 */
  totalTokens: number;
}

export function calculateTokenUsage(messages: NonSystemMessage[]): TokenUsageSummary {
  return messages.reduce<TokenUsageSummary>(
    (summary, message) => {
      if (!isAssistantMessage(message) || !message.usage) {
        return summary;
      }

      return {
        latestInputTokens: message.usage.promptTokens,
        totalTokens: summary.totalTokens + message.usage.totalTokens,
      };
    },
    { latestInputTokens: 0, totalTokens: 0 },
  );
}

function isAssistantMessage(message: NonSystemMessage): message is AssistantMessage {
  return message.role === "assistant";
}
