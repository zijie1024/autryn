import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { formatConfigLoadError, getConfigFilePath, loadConfig, saveConfig } from "@/terminal/config/index";
import type { AutrynConfig } from "@/terminal/config/schema";
import { autrynConfigSchema } from "@/terminal/config/schema";

let fakeHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  fakeHome = await mkdtemp(join(tmpdir(), "autryn-config-load-"));
  previousHome = Bun.env.AUTRYN_HOME;
  Bun.env.AUTRYN_HOME = fakeHome;
  await mkdir(fakeHome, { recursive: true });
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete Bun.env.AUTRYN_HOME;
  } else {
    Bun.env.AUTRYN_HOME = previousHome;
  }
  await rm(fakeHome, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("round-trips a config through save and load", async () => {
    const config: AutrynConfig = {
      models: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "gpt",
          model: "gpt-4",
          baseURL: "https://api.openai.com/v1",
          APIKey: "sk-openai",
          provider: "openai",
          contextWindowTokens: 128000,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "claude",
          model: "claude-sonnet",
          baseURL: "https://api.anthropic.com",
          APIKey: "sk-ant",
          provider: "anthropic",
          contextWindowTokens: 200000,
        },
      ],
      agentGroups: [
        {
          id: "default-coding",
          name: "Default Coding",
          entryAgentId: "code",
          agents: [
            {
              id: "code",
              name: "Code",
              description: "Default Code Agent",
              instructions: "Work on the requested coding task.",
              modelConfigId: "11111111-1111-4111-8111-111111111111",
              delegates: [],
              handoffs: [],
            },
          ],
        },
      ],
      defaultAgentGroupId: "default-coding",
      defaultExecutionMode: "execute",
    };

    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });

  test("rejects a config with missing required fields", async () => {
    await writeFile(
      getConfigFilePath(),
      ["models:", "  - name: gpt", "    baseURL: https://api.openai.com/v1", "    APIKey: sk", ""].join("\n"),
      "utf8",
    );
    expect(() => loadConfig()).toThrow();
  });
});

describe("formatConfigLoadError", () => {
  test("reports issue paths and guidance without leaking values", () => {
    const bad = {
      models: [{ name: "", baseURL: "not-a-url", APIKey: "sk-super-secret-value" }],
      agentGroups: [],
      defaultAgentGroupId: "missing",
    };
    let caught: unknown;
    try {
      loadConfigInMemory(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();

    const message = formatConfigLoadError(caught, "/fake/config.yaml");
    expect(message).toContain("/fake/config.yaml");
    expect(message).toContain("models.0.name");
    expect(message).not.toContain("sk-super-secret-value");
    expect(message).not.toContain("not-a-url");
  });

  test("handles non-Zod parse failures", () => {
    const message = formatConfigLoadError(new Error("boom"), "/fake/config.yaml");
    expect(message).toContain("could not be parsed as YAML");
    expect(message).toContain("Edit the file to fix it");
  });
});

function loadConfigInMemory(value: unknown) {
  // 与 loadConfig 使用同一 schema，但作用于内存值，测试无需把无效密钥写入磁盘。
  return autrynConfigSchema.parse(value);
}
