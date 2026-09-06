import type { Message } from "../messages";

import type { ModelContext } from "./model-context";
import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

export interface ModelCapabilities {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

/**
 * 可调用 model provider 生成文本的模型句柄。
 */
export class Model {
  constructor(
    readonly name: string,
    readonly provider: ModelProvider,
    readonly options?: Record<string, unknown>,
    readonly capabilities?: ModelCapabilities,
  ) {}

  withOptions(options: Record<string, unknown>, capabilities = this.capabilities): Model {
    return new Model(this.name, this.provider, options, capabilities);
  }

  /** 调用 model 生成回复。 */
  invoke(context: ModelContext) {
    const params = this._buildModelProviderParams(context);
    return this.provider.invoke(params);
  }

  /** 流式获取 model 回复，逐步产出累积快照。 */
  stream(context: ModelContext) {
    const params = this._buildModelProviderParams(context);
    return this.provider.stream(params);
  }

  private _buildModelProviderParams(context: ModelContext): ModelProviderInvokeParams {
    const messages: Message[] = [];
    if (context.prompt) {
      messages.push({ role: "system", content: [{ type: "text", text: context.prompt }] });
    }
    messages.push(...context.messages);
    return {
      model: this.name,
      options: this.options,
      messages,
      tools: context.tools,
      signal: context.signal,
    };
  }
}
