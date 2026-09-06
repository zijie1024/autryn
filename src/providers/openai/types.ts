import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from "openai/resources";

export interface OpenAIReasoningFields {
  reasoning_content?: string | null;
}

export type OpenAIAssistantMessageParam = ChatCompletionAssistantMessageParam & OpenAIReasoningFields;

export type OpenAIChatCompletionMessage = ChatCompletionMessage & OpenAIReasoningFields;

export type OpenAIChatCompletionMessageParam = ChatCompletionMessageParam | OpenAIAssistantMessageParam;

export type OpenAIChatCompletionChunk = ChatCompletionChunk & {
  choices: Array<
    ChatCompletionChunk["choices"][number] & {
      delta: ChatCompletionChunk["choices"][number]["delta"] & OpenAIReasoningFields;
    }
  >;
};

export function getReasoningContent(value: OpenAIReasoningFields): string | undefined {
  const reasoning = value.reasoning_content;
  return typeof reasoning === "string" ? reasoning : undefined;
}
