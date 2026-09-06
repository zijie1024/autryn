import { describe, expect, test } from "bun:test";

import { autrynConfigSchema } from "@/terminal/config";
import { AgentRegistry, intersectMemoryAccess, intersectToolProfile } from "@/terminal/session/agent-registry";
import { ModelResolver } from "@/terminal/session/model-resolver";

const MODEL_A = "11111111-1111-4111-8111-111111111111";
const MODEL_B = "22222222-2222-4222-8222-222222222222";

describe("AgentRegistry", () => {
  test("Delegate constraints only reduce target capabilities", () => {
    expect(intersectToolProfile("none", "read_only")).toBe("none");
    expect(intersectToolProfile("read_only", "read_only")).toBe("read_only");
    expect(intersectToolProfile("coding", "read_only")).toBe("read_only");
    expect(intersectMemoryAccess({ access: "none", autoWrite: false }, "read_only")).toEqual({
      access: "none",
      autoWrite: false,
    });
    expect(intersectMemoryAccess({ access: "read_write", autoWrite: true }, "read_only")).toEqual({
      access: "read",
      autoWrite: false,
    });
  });

  test("freezes a validated Group and merges partial capability overrides", () => {
    const config = configuration();
    const registry = new AgentRegistry(config, new ModelResolver(config));

    const frozen = registry.freeze("default-coding");
    const code = frozen.agents.get("code")!;
    const reviewer = frozen.agents.get("reviewer")!;

    expect(frozen.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(code.capabilities).toMatchObject({ toolProfile: "coding", approval: true, skills: false, todo: false });
    expect(code.capabilities.memory).toEqual({
      global: { access: "read", autoWrite: false },
      project: { access: "read_write", autoWrite: true },
    });
    expect(reviewer.resolvedModel.entry.id).toBe(MODEL_B);
    expect(reviewer.capabilities).toMatchObject({ toolProfile: "read_only", approval: false });
  });

  test("rejects model overrides for Agents outside the active Group", () => {
    const config = configuration();
    const registry = new AgentRegistry(config, new ModelResolver(config));

    expect(() => registry.freeze("default-coding", { missing: MODEL_B })).toThrow(
      "Model override references Agent missing",
    );
  });

  test("revision covers frozen model bindings and non-secret model behavior", () => {
    const base = configuration();
    const baseRevision = new AgentRegistry(base, new ModelResolver(base)).freeze("default-coding").revision;

    const capabilityChanged = structuredClone(base);
    capabilityChanged.models[0]!.contextWindowTokens += 1;
    expect(
      new AgentRegistry(capabilityChanged, new ModelResolver(capabilityChanged)).freeze("default-coding").revision,
    ).not.toBe(baseRevision);

    const summaryBindingChanged = structuredClone(base);
    summaryBindingChanged.contextCompaction = { summaryModelConfigId: MODEL_B };
    expect(
      new AgentRegistry(summaryBindingChanged, new ModelResolver(summaryBindingChanged)).freeze("default-coding").revision,
    ).not.toBe(baseRevision);

    const registry = new AgentRegistry(base, new ModelResolver(base));
    expect(registry.freeze("default-coding", { code: MODEL_B }).revision).not.toBe(baseRevision);

    const secretRotated = structuredClone(base);
    secretRotated.models[0]!.APIKey = "sk-rotated";
    expect(
      new AgentRegistry(secretRotated, new ModelResolver(secretRotated)).freeze("default-coding").revision,
    ).toBe(baseRevision);
  });

  test("creates entry and successor configurations through the same capability-aware factory", async () => {
    const previousHome = Bun.env.AUTRYN_HOME;
    Bun.env.AUTRYN_HOME = process.cwd();
    try {
      const config = configuration();
      const registry = new AgentRegistry(config, new ModelResolver(config));
      const group = registry.freeze("default-coding");
      const options = { group, cwd: process.cwd(), messages: [] };

      const source = await registry.createConfiguration("code", options);
      const reviewer = await source.handoffs![0]!.create({} as never);

      expect(source.middlewares?.map((middleware) => middleware.name)).toContain("coding-approval");
      expect(source.handoffs?.map((handoff) => handoff.target)).toContain("reviewer");
      expect(source.tools?.map((tool) => tool.name)).toContain("write_file");
      expect(source.tools?.map((tool) => tool.name)).toContain("phase_transition");
      expect(reviewer.model.name).toBe("reviewer-model");
      expect(reviewer.prompt).toContain("Reviews completed changes");
      expect(reviewer.prompt).toContain("Focus on correctness and design quality.");
      expect(reviewer.tools?.map((tool) => tool.name)).not.toContain("write_file");
      expect(reviewer.tools?.map((tool) => tool.name)).not.toContain("phase_transition");
      expect(reviewer.middlewares?.map((middleware) => middleware.name)).not.toContain("coding-approval");
    } finally {
      if (previousHome === undefined) delete Bun.env.AUTRYN_HOME;
      else Bun.env.AUTRYN_HOME = previousHome;
    }
  });
});

function configuration() {
  return autrynConfigSchema.parse({
    models: [
      {
        id: MODEL_A,
        name: "main",
        model: "main-model",
        baseURL: "https://api.openai.com/v1",
        APIKey: "sk-main",
        provider: "openai",
        contextWindowTokens: 128000,
      },
      {
        id: MODEL_B,
        name: "reviewer",
        model: "reviewer-model",
        baseURL: "https://api.anthropic.com",
        APIKey: "sk-reviewer",
        provider: "anthropic",
        contextWindowTokens: 200000,
        contextCompactionMode: "off",
      },
    ],
    agentGroups: [
      {
        id: "default-coding",
        name: "Default Coding",
        entryAgentId: "code",
        defaults: {
          modelConfigId: MODEL_A,
          capabilities: {
            skills: false,
            memory: {
              global: { access: "read", autoWrite: false },
              project: { access: "read_write", autoWrite: true },
            },
          },
        },
        agents: [
          {
            id: "code",
            name: "Code",
            description: "Implements requested changes",
            capabilities: { todo: false },
            delegates: [],
            handoffs: [{ target: "reviewer", description: "Review the completed implementation" }],
          },
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Reviews completed changes",
            instructions: "Focus on correctness and design quality.",
            modelConfigId: MODEL_B,
            capabilities: {
              toolProfile: "read_only",
              approval: false,
              todo: false,
              projectGuidance: false,
              memory: {
                global: { access: "none", autoWrite: false },
                project: { access: "read", autoWrite: false },
              },
            },
            delegates: [],
            handoffs: [],
          },
        ],
      },
    ],
    defaultAgentGroupId: "default-coding",
    defaultExecutionMode: "execute",
  });
}
