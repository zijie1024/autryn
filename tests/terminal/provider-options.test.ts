import { describe, expect, test } from "bun:test";

import {
  buildEntryFromProviderOption,
  maskSecret,
  PROVIDER_OPTIONS,
  validateApiKey,
  validateBaseURL,
  validateContextWindowTokens,
  validateModelName,
} from "@/terminal/provider-options";

const byId = (id: string) => PROVIDER_OPTIONS.find((option) => option.id === id)!;

describe("PROVIDER_OPTIONS", () => {
  test("exposes exactly the four confirmed entries with exact labels", () => {
    expect(PROVIDER_OPTIONS.map((option) => option.label)).toEqual([
      "Anthropic (Official)",
      "OpenAI (Official)",
      "Anthropic-compatible (Custom)",
      "OpenAI-compatible (Custom)",
    ]);
  });

  test("has no vendor presets, no legacy Other entry, and no duplicated labels", () => {
    const labels = PROVIDER_OPTIONS.map((option) => option.label.toLowerCase());
    for (const vendor of ["volcengine", "qwen", "minimax", "glm", "zhipu", "kimi", "moonshot", "deepseek", "other"]) {
      expect(labels.some((label) => label.includes(vendor))).toBe(false);
    }
    expect(new Set(PROVIDER_OPTIONS.map((option) => option.label)).size).toBe(PROVIDER_OPTIONS.length);
  });

  test("maps official/custom to correct provider types and baseURL requirements", () => {
    expect(byId("anthropic-official").providerType).toBe("anthropic");
    expect(byId("anthropic-official").requiresCustomBaseURL).toBe(false);
    expect(byId("openai-official").providerType).toBe("openai");
    expect(byId("openai-official").requiresCustomBaseURL).toBe(false);
    expect(byId("anthropic-compatible").providerType).toBe("anthropic");
    expect(byId("anthropic-compatible").requiresCustomBaseURL).toBe(true);
    expect(byId("openai-compatible").providerType).toBe("openai");
    expect(byId("openai-compatible").requiresCustomBaseURL).toBe(true);
  });
});

describe("validateBaseURL", () => {
  test("accepts https URLs", () => {
    expect(validateBaseURL("https://api.example.com/v1")).toBeNull();
  });

  test("accepts local http endpoints for development", () => {
    expect(validateBaseURL("http://localhost:8080/v1")).toBeNull();
    expect(validateBaseURL("http://127.0.0.1:9/v1")).toBeNull();
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validateBaseURL("  https://api.example.com/v1  ")).toBeNull();
  });

  test("rejects empty input", () => {
    expect(validateBaseURL("")?.field).toBe("baseURL");
    expect(validateBaseURL("   ")?.field).toBe("baseURL");
  });

  test("rejects bare numbers, relative paths and non-http(s) schemes", () => {
    expect(validateBaseURL("4")?.field).toBe("baseURL");
    expect(validateBaseURL("api/v1")?.field).toBe("baseURL");
    expect(validateBaseURL("file:///tmp/x")?.field).toBe("baseURL");
    expect(validateBaseURL("ftp://example.com")?.field).toBe("baseURL");
  });
});

describe("validateModelName / validateApiKey", () => {
  test("rejects empty and whitespace-only values with distinct fields", () => {
    expect(validateModelName("")?.field).toBe("modelName");
    expect(validateModelName("  ")?.field).toBe("modelName");
    expect(validateApiKey("")?.field).toBe("apiKey");
    expect(validateApiKey("\t")?.field).toBe("apiKey");
  });

  test("accepts non-empty values", () => {
    expect(validateModelName("gpt-4o")).toBeNull();
    expect(validateApiKey("sk-test")).toBeNull();
  });
});

describe("validateContextWindowTokens", () => {
  test("accepts positive integer token counts", () => {
    expect(validateContextWindowTokens("128000")).toBeNull();
    expect(validateContextWindowTokens(" 32000 ")).toBeNull();
  });

  test("rejects missing, zero, negative and decimal values", () => {
    expect(validateContextWindowTokens("")?.field).toBe("contextWindowTokens");
    expect(validateContextWindowTokens("0")?.field).toBe("contextWindowTokens");
    expect(validateContextWindowTokens("-1")?.field).toBe("contextWindowTokens");
    expect(validateContextWindowTokens("12.5")?.field).toBe("contextWindowTokens");
  });
});

describe("buildEntryFromProviderOption", () => {
  test("official entries use the fixed baseURL without user input", () => {
    const anthropic = buildEntryFromProviderOption(byId("anthropic-official"), {
      modelName: "claude-sonnet",
      apiKey: "sk-ant-test",
      contextWindowTokens: "200000",
    });
    expect(anthropic.ok).toBe(true);
    if (anthropic.ok) {
      expect(anthropic.entry).toEqual({
        id: expect.any(String),
        name: "claude-sonnet",
        model: "claude-sonnet",
        baseURL: "https://api.anthropic.com",
        APIKey: "sk-ant-test",
        provider: "anthropic",
        contextWindowTokens: 200000,
        contextCompactionMode: "auto",
      });
    }

    const openai = buildEntryFromProviderOption(byId("openai-official"), {
      modelName: "gpt-4o",
      apiKey: "sk-test",
      contextWindowTokens: "128000",
    });
    expect(openai.ok).toBe(true);
    if (openai.ok) {
      expect(openai.entry.baseURL).toBe("https://api.openai.com/v1");
      expect(openai.entry.provider).toBe("openai");
    }
  });

  test("custom entries require a valid baseURL and map the provider type", () => {
    const missing = buildEntryFromProviderOption(byId("openai-compatible"), {
      modelName: "deepseek-chat",
      apiKey: "sk-test",
      contextWindowTokens: "64000",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues.map((issue) => issue.field)).toEqual(["baseURL"]);
    }

    const filled = buildEntryFromProviderOption(byId("openai-compatible"), {
      modelName: " deepseek-chat ",
      apiKey: " sk-test ",
      contextWindowTokens: " 64000 ",
      customBaseURL: " https://api.deepseek.com/v1 ",
    });
    expect(filled.ok).toBe(true);
    if (filled.ok) {
      expect(filled.entry).toEqual({
        id: expect.any(String),
        name: "deepseek-chat",
        model: "deepseek-chat",
        baseURL: "https://api.deepseek.com/v1",
        APIKey: "sk-test",
        provider: "openai",
        contextWindowTokens: 64000,
        contextCompactionMode: "auto",
      });
    }

    const anthropicCustom = buildEntryFromProviderOption(byId("anthropic-compatible"), {
      modelName: "proxy-model",
      apiKey: "key",
      contextWindowTokens: "32000",
      customBaseURL: "http://localhost:9090",
    });
    expect(anthropicCustom.ok).toBe(true);
    if (anthropicCustom.ok) {
      expect(anthropicCustom.entry.provider).toBe("anthropic");
      expect(anthropicCustom.entry.baseURL).toBe("http://localhost:9090");
    }
  });

  test("collects all field issues without throwing", () => {
    const result = buildEntryFromProviderOption(byId("anthropic-compatible"), {
      modelName: "",
      apiKey: "",
      contextWindowTokens: "",
      customBaseURL: "not a url",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.field).sort()).toEqual([
        "apiKey",
        "baseURL",
        "contextWindowTokens",
        "modelName",
      ]);
    }
  });
});

describe("maskSecret", () => {
  test("never renders the full secret", () => {
    const secret = "sk-ant-api03-very-long-secret-value";
    const masked = maskSecret(secret);
    expect(masked).not.toContain(secret);
    expect(masked.length).toBe(secret.length);
    expect(masked.endsWith(secret.slice(-8))).toBe(true);
    expect(masked.startsWith("****")).toBe(true);
  });

  test("fully masks short secrets", () => {
    expect(maskSecret("abc")).toBe("***");
    expect(maskSecret("")).toBe("*");
  });

  test("error messages for invalid baseURL never include API keys", () => {
    const issue = validateBaseURL("4");
    expect(issue?.error.includes("sk-ant-api03-very-long-secret-value")).toBe(false);
  });
});
