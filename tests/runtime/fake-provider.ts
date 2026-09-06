import type { AssistantMessage, ModelProvider, ModelProviderInvokeParams } from "@/core";

/**
 * 一个脚本化的 model 步骤：接收调用序号（0 起）与 provider 被调用时的参数，
 * 返回该步 stream 应产出的累积快照。一步的最后一个快照应携带 `usage`
 *（且不带 `streaming: true`），才会被 agent 视为最终结果。
 */

export type ScriptedStep = (callIndex: number, params: ModelProviderInvokeParams) => AssistantMessage[];

/**
 * 供 agent loop 测试使用的确定性 fake provider。
 * 每次 `stream()` 调用消费下一个脚本化步骤；`invoke()` 不会被 agent loop 使用，
 * 若被调用会大声失败。
 */
export function createScriptedProvider(steps: ScriptedStep[]): {
  provider: ModelProvider;
  calls: ModelProviderInvokeParams[];
} {
  const calls: ModelProviderInvokeParams[] = [];

  const provider: ModelProvider = {
    async invoke() {
      throw new Error("invoke() must not be used by agent loop tests");
    },
    async *stream(params) {
      const index = calls.length;
      calls.push(params);
      const step = steps[index];
      if (!step) {
        throw new Error(`Scripted provider has no step for call ${index}`);
      }
      for (const snapshot of step(index, params)) {
        yield snapshot;
      }
    },
  };

  return { provider, calls };
}

/** Builds a final (non-streaming) assistant text message. */
export function finalTextMessage(text: string, totalTokens = 10): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { promptTokens: Math.ceil(totalTokens / 2), completionTokens: Math.floor(totalTokens / 2), totalTokens },
  };
}

/** Builds a final assistant message that requests one or more tool calls. */
export function finalToolUseMessage(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  totalTokens = 10,
): AssistantMessage {
  return {
    role: "assistant",
    content: toolUses.map((toolUse) => ({ type: "tool_use", ...toolUse })),
    usage: { promptTokens: Math.ceil(totalTokens / 2), completionTokens: Math.floor(totalTokens / 2), totalTokens },
  };
}

/** A deferred completion handle so tests control exactly when a tool finishes. */
export type Deferred<T> = {
  promise: Promise<T>;
   
  resolve: (value: T) => void;
   
  reject: (error: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
   
  let resolve!: (value: T) => void;
   
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
