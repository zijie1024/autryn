import { OpenAI } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources";

import type { AssistantMessage, Message, ModelProvider, Tool } from "@/core";

import { StreamAccumulator, toTokenUsage } from "./stream-utils";
import { convertToOpenAIMessages, convertToOpenAITools, parseAssistantMessage } from "./utils";

/** OpenAI API 的 provider 适配器。 */
export class OpenAIModelProvider implements ModelProvider {
  _client: OpenAI;

  constructor({ baseURL, apiKey }: { baseURL?: string; apiKey?: string } = {}) {
    this._client = new OpenAI({
      baseURL,
      apiKey,
    });
  }

  async invoke({
    model,
    messages,
    tools,
    options,
    signal,
  }: {
    model: string;
    messages: Message[];
    tools?: Tool[];
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }) {
    const params = this._baseChatCompletionParams({
      model,
      messages,
      tools,
      options,
    }) satisfies ChatCompletionCreateParamsNonStreaming;
    const response = await this._client.chat.completions.create(params, { signal });
    return parseAssistantMessage(response.choices[0]!.message!, toTokenUsage(response.usage));
  }

  async *stream({
    model,
    messages,
    tools,
    options,
    signal,
  }: {
    model: string;
    messages: Message[];
    tools?: Tool[];
    options?: Record<string, unknown>;
    signal?: AbortSignal;
  }): AsyncGenerator<AssistantMessage> {
    const response = await this._client.chat.completions.create(
      {
        ...this._baseChatCompletionParams({ model, messages, tools, options }),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    const acc = new StreamAccumulator();
    for await (const chunk of response) {
      acc.push(chunk);
      yield acc.snapshot();
    }
  }

  private _baseChatCompletionParams({
    model,
    messages,
    tools,
    options,
  }: {
    model: string;
    messages: Message[];
    tools?: Tool[];
    options?: Record<string, unknown>;
  }) {
    return {
      model,
      messages: convertToOpenAIMessages(messages),
      tools: tools ? convertToOpenAITools(tools) : undefined,
      temperature: 0,
      ...options,
    };
  }
}
