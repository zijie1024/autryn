import { describe, expect, test } from "bun:test";

import { ModelResolver } from "@/terminal/session/model-resolver";

const MODEL_A = "11111111-1111-4111-8111-111111111111";
const MODEL_B = "22222222-2222-4222-8222-222222222222";

describe("ModelResolver", () => {
  test("maps configured model capabilities into Model instances", () => {
    const resolved = new ModelResolver(config()).resolve(MODEL_A);
    expect(resolved.model.capabilities).toEqual({ contextWindowTokens: 128000, maxOutputTokens: 16000 });
  });

  test("resolves summary model without mutating the active model options", () => {
    const resolver = new ModelResolver(config());
    const active = resolver.resolve(MODEL_A);
    const summary = resolver.summaryModel(active);

    expect(summary.entry.id).toBe(MODEL_B);
    expect(summary.model.name).toBe("gpt-summary");
    expect(summary.model.options).toEqual({ max_tokens: 2048 });
    expect(active.model.options).toEqual({ max_tokens: 16 * 1024, thinking: { type: "enabled" } });
  });
});

function config() {
  return {
    models: [
      {
        id: MODEL_A,
        name: "main",
        model: "gpt-main",
        baseURL: "https://api.openai.com/v1",
        APIKey: "sk-main",
        provider: "openai" as const,
        contextWindowTokens: 128000,
        maxOutputTokens: 16000,
      },
      {
        id: MODEL_B,
        name: "summary",
        model: "gpt-summary",
        baseURL: "https://api.openai.com/v1",
        APIKey: "sk-summary",
        provider: "openai" as const,
        contextWindowTokens: 32000,
        maxOutputTokens: 4096,
      },
    ],
    agentGroups: [{
      id: "default-coding",
      name: "Default Coding",
      entryAgentId: "code",
      defaults: { modelConfigId: MODEL_A },
      agents: [{ id: "code", name: "Code", description: "Codes", delegates: [], handoffs: [] }],
    }],
    defaultAgentGroupId: "default-coding",
    defaultExecutionMode: "execute" as const,
    contextCompaction: { summaryModelConfigId: MODEL_B },
  };
}
