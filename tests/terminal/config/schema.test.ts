import { describe, expect, test } from "bun:test";

import { autrynConfigSchema, modelEntrySchema } from "@/terminal/config/schema";

const MODEL_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

describe("modelEntrySchema", () => {
  test("accepts config entries with stable id and model name split", () => {
    const result = modelEntrySchema.safeParse({
      id: MODEL_ID,
      name: "Work model",
      model: "gpt-4",
      baseURL: "https://api.openai.com/v1",
      APIKey: "sk-xxx",
      provider: "openai",
      contextWindowTokens: 128000,
      maxOutputTokens: 16000,
      contextCompactionMode: "auto",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing id/model, empty fields and invalid provider", () => {
    expect(modelEntrySchema.safeParse({ name: "gpt-4", baseURL: "x", APIKey: "sk", provider: "openai" }).success).toBe(
      false,
    );
    expect(
      modelEntrySchema.safeParse({
        id: MODEL_ID,
        name: "",
        model: "gpt-4",
        baseURL: "x",
        APIKey: "sk",
        provider: "openai",
        contextWindowTokens: 128000,
      }).success,
    ).toBe(false);
    expect(
      modelEntrySchema.safeParse({
        id: MODEL_ID,
        name: "x",
        model: "",
        baseURL: "x",
        APIKey: "sk",
        provider: "openai",
        contextWindowTokens: 128000,
      }).success,
    ).toBe(false);
    expect(
      modelEntrySchema.safeParse({
        id: MODEL_ID,
        name: "x",
        model: "m",
        baseURL: "x",
        APIKey: "",
        provider: "openai",
        contextWindowTokens: 128000,
      }).success,
    ).toBe(false);
    expect(
      modelEntrySchema.safeParse({
        id: MODEL_ID,
        name: "x",
        model: "m",
        baseURL: "x",
        APIKey: "sk",
        provider: "invalid",
        contextWindowTokens: 128000,
      }).success,
    ).toBe(false);
    expect(
      modelEntrySchema.safeParse({
        id: MODEL_ID,
        name: "x",
        model: "m",
        baseURL: "x",
        APIKey: "sk",
        provider: "openai",
      }).success,
    ).toBe(false);
  });
});

describe("autrynConfigSchema", () => {
  test("accepts a valid config with a default Agent Group", () => {
    const result = autrynConfigSchema.safeParse({
      models: [
        {
          id: MODEL_ID,
          name: "gpt",
          model: "gpt-4",
          baseURL: "https://api.openai.com/v1",
          APIKey: "sk",
          provider: "openai",
          contextWindowTokens: 128000,
        },
      ],
      agentGroups: [agentGroup(MODEL_ID)],
      defaultAgentGroupId: "default-coding",
      defaultExecutionMode: "execute",
    });
    expect(result.success).toBe(true);
  });

  test("validates summary model references", () => {
    const valid = autrynConfigSchema.safeParse({
      models: [
        {
          id: MODEL_ID,
          name: "gpt",
          model: "gpt-4",
          baseURL: "x",
          APIKey: "sk",
          provider: "openai",
          contextWindowTokens: 128000,
        },
        {
          id: OTHER_ID,
          name: "summary",
          model: "gpt-4o-mini",
          baseURL: "x",
          APIKey: "sk",
          provider: "openai",
          contextWindowTokens: 32000,
        },
      ],
      agentGroups: [agentGroup(MODEL_ID)],
      defaultAgentGroupId: "default-coding",
      defaultExecutionMode: "execute",
      contextCompaction: { summaryModelConfigId: OTHER_ID },
    });
    expect(valid.success).toBe(true);

    const invalid = autrynConfigSchema.safeParse({
      models: [
        {
          id: MODEL_ID,
          name: "gpt",
          model: "gpt-4",
          baseURL: "x",
          APIKey: "sk",
          provider: "openai",
          contextWindowTokens: 128000,
        },
      ],
      agentGroups: [agentGroup(MODEL_ID)],
      defaultAgentGroupId: "default-coding",
      contextCompaction: { summaryModelConfigId: OTHER_ID },
    });
    expect(invalid.success).toBe(false);
  });

  test("rejects empty models, duplicate names and missing default group", () => {
    expect(
      autrynConfigSchema.safeParse({
        models: [],
        agentGroups: [agentGroup(MODEL_ID)],
        defaultAgentGroupId: "default-coding",
      }).success,
    ).toBe(false);
    expect(
      autrynConfigSchema.safeParse({
        models: [
          {
            id: MODEL_ID,
            name: "gpt",
            model: "gpt-4",
            baseURL: "x",
            APIKey: "sk",
            provider: "openai",
            contextWindowTokens: 128000,
          },
        ],
        agentGroups: [agentGroup(MODEL_ID)],
        defaultAgentGroupId: "missing",
      }).success,
    ).toBe(false);
    expect(
      autrynConfigSchema.safeParse({
        models: [
          {
            id: MODEL_ID,
            name: "gpt",
            model: "gpt-4",
            baseURL: "x",
            APIKey: "sk",
            provider: "openai",
            contextWindowTokens: 128000,
          },
          {
            id: OTHER_ID,
            name: "GPT",
            model: "gpt-4o",
            baseURL: "x",
            APIKey: "sk",
            provider: "openai",
            contextWindowTokens: 128000,
          },
        ],
        agentGroups: [agentGroup(MODEL_ID)],
        defaultAgentGroupId: "default-coding",
      }).success,
    ).toBe(false);
  });

  test("accepts partial Agent capability overrides and rejects invalid Memory auto-write", () => {
    const base = {
      models: [
        {
          id: MODEL_ID,
          name: "gpt",
          model: "gpt-4",
          baseURL: "x",
          APIKey: "sk",
          provider: "openai" as const,
          contextWindowTokens: 128000,
        },
      ],
      defaultAgentGroupId: "default-coding",
      defaultExecutionMode: "execute" as const,
    };
    const validGroup = agentGroup(MODEL_ID);
    const validAgentGroups = [{
      ...validGroup,
      agents: validGroup.agents.map((agent) => ({ ...agent, capabilities: { todo: false } })),
    }];
    expect(autrynConfigSchema.safeParse({ ...base, agentGroups: validAgentGroups }).success).toBe(true);

    const invalidGroup = agentGroup(MODEL_ID);
    const invalidAgentGroups = [{
      ...invalidGroup,
      agents: invalidGroup.agents.map((agent) => ({
        ...agent,
        capabilities: { memory: { global: { access: "read", autoWrite: true } } },
      })),
    }];
    expect(autrynConfigSchema.safeParse({ ...base, agentGroups: invalidAgentGroups }).success).toBe(false);
  });

  test("rejects invalid Agent graph edges and unreachable profiles", () => {
    const base = {
      models: [{
        id: MODEL_ID,
        name: "gpt",
        model: "gpt-4",
        baseURL: "x",
        APIKey: "sk",
        provider: "openai" as const,
        contextWindowTokens: 128000,
      }],
      defaultAgentGroupId: "default-coding",
      defaultExecutionMode: "execute" as const,
    };
    const invalid = {
      ...base,
      agentGroups: [{
        ...agentGroup(MODEL_ID),
        agents: [
          {
            ...agentGroup(MODEL_ID).agents[0],
            handoffs: [{ target: "code", description: "self" }, { target: "missing", description: "missing" }],
          },
          {
            id: "orphan",
            name: "Orphan",
            description: "Unreachable",
            modelConfigId: MODEL_ID,
            delegates: [],
            handoffs: [],
          },
        ],
      }],
    };
    expect(autrynConfigSchema.safeParse(invalid).success).toBe(false);
  });
});

function agentGroup(modelConfigId: string) {
  return {
    id: "default-coding",
    name: "Default Coding",
    entryAgentId: "code",
    agents: [
      {
        id: "code",
        name: "Code",
        description: "Default Code Agent",
        instructions: "Work on the requested coding task.",
        modelConfigId,
        delegates: [],
        handoffs: [],
      },
    ],
  };
}
