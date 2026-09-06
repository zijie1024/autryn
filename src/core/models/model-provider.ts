import type { AssistantMessage, Message } from "../messages";
import type { Tool } from "../tools";

export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * 模型服务适配器：将统一的 invoke/stream 契约转发到具体模型 API。
 */
export interface ModelProvider {
  /** 调用 model 生成完整回复。 */
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;

  /**
   * 流式获取 model 回复，每次产出逐步补全的累积快照。
   * 每个产出都是比上一个更完整的 {@link AssistantMessage}，
   * 最终产出等价于 {@link invoke} 的返回结果。
   */
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}
