import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, ModelProvider, ModelProviderInvokeParams, TokenUsage } from "@/core";

import { StreamAccumulator } from "./stream-utils";
import {
  convertToAnthropicMessages,
  convertToAnthropicTools,
  extractSystemPrompt,
  parseAssistantMessage,
} from "./utils";

/**
 * Anthropic API（Claude 模型）的 provider 适配器。
 */
export class AnthropicModelProvider implements ModelProvider {
  _client: Anthropic;

  constructor({ baseURL, apiKey }: { baseURL?: string; apiKey?: string } = {}) {
    // 仅在 baseURL 与 SDK 默认值不同时才传入，使标准 Anthropic 端点
    // 走 SDK 自带的 URL 构造逻辑。
    const isDefaultURL = !baseURL || baseURL === "https://api.anthropic.com";
    this._client = new Anthropic({
      ...(isDefaultURL ? {} : { baseURL }),
      apiKey,
    });
  }

  async invoke(params: ModelProviderInvokeParams) {
    const response = await this._client.messages.create(this._baseMessageParams(params), {
      signal: params.signal,
    });
    return parseAssistantMessage(response, toTokenUsage(response.usage));
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this._client.messages.create(
      { ...this._baseMessageParams(params), stream: true },
      { signal: params.signal },
    );

    const acc = new StreamAccumulator();
    for await (const event of response) {
      acc.push(event);
      yield acc.snapshot();
    }
  }

  private _baseMessageParams({
    model,
    messages,
    tools,
    options,
  }: ModelProviderInvokeParams): Anthropic.MessageCreateParamsNonStreaming {
    const system = extractSystemPrompt(messages);
    const anthropicMessages = convertToAnthropicMessages(messages);
    const anthropicTools = tools ? convertToAnthropicTools(tools) : undefined;

    // 针对 Anthropic API 规范化 options：
    // 开启 thinking 时，Anthropic 要求提供 `budget_tokens`，这里默认取
    // max_tokens 减去少量余量作为响应预算。调用方传入的 options 对象
    //（通常是长生命周期的 Model.options）不会被修改，而是构建一份规范化副本。
    const normalizedOptions = { ...options };
    const thinking = normalizedOptions.thinking as { type: string; budget_tokens?: number } | undefined;
    if (thinking?.type === "enabled" && !thinking.budget_tokens) {
      const maxTokens = (normalizedOptions.max_tokens as number | undefined) ?? 8192;
      normalizedOptions.thinking = { ...thinking, budget_tokens: Math.floor(maxTokens * 0.8) };
    }

    return {
      model,
      max_tokens: 8192,
      messages: anthropicMessages,
      ...(system ? { system } : {}),
      ...(anthropicTools && anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
      ...normalizedOptions,
    };
  }
}

function toTokenUsage(usage?: Anthropic.Usage): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  };
}
