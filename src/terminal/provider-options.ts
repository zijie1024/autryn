import type { ModelEntry } from "./config";

/**
 * 首次运行 wizard 与 `autryn config model add` 提供的全部 provider 选项。
 * 第三方网关、代理以及 OpenAI/Anthropic 兼容服务都通过两个 `Custom` 项配置，
 * 绝不把它们标注为官方服务。
 */
export type ProviderOptionId = "anthropic-official" | "openai-official" | "anthropic-compatible" | "openai-compatible";

export interface ProviderOption {
  id: ProviderOptionId;
  /** 选择器中展示的确切标签；也用于 help/docs。 */
  label: string;
  /** 写入配置项的 provider 类型。 */
  providerType: NonNullable<ModelEntry["provider"]>;
  /** 官方项带固定 baseURL；自定义项需要用户提供。 */
  requiresCustomBaseURL: boolean;
  /** 官方项的固定 baseURL；自定义项缺省。 */
  officialBaseURL?: string;
}

export const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: "anthropic-official",
    label: "Anthropic (Official)",
    providerType: "anthropic",
    requiresCustomBaseURL: false,
    officialBaseURL: "https://api.anthropic.com",
  },
  {
    id: "openai-official",
    label: "OpenAI (Official)",
    providerType: "openai",
    requiresCustomBaseURL: false,
    officialBaseURL: "https://api.openai.com/v1",
  },
  {
    id: "anthropic-compatible",
    label: "Anthropic-compatible (Custom)",
    providerType: "anthropic",
    requiresCustomBaseURL: true,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible (Custom)",
    providerType: "openai",
    requiresCustomBaseURL: true,
  },
];

export type ConfigFieldIssue =
  | { field: "modelName"; error: string }
  | { field: "apiKey"; error: string }
  | { field: "baseURL"; error: string }
  | { field: "contextWindowTokens"; error: string };

export function validateModelName(raw: string): ConfigFieldIssue | null {
  if (raw.trim().length === 0) {
    return { field: "modelName", error: "Model name must not be empty. Enter a name, e.g. `gpt-4o`." };
  }
  return null;
}

export function validateApiKey(raw: string): ConfigFieldIssue | null {
  if (raw.trim().length === 0) {
    return { field: "apiKey", error: "API key must not be empty. Enter the API key for this provider." };
  }
  return null;
}

export function validateContextWindowTokens(raw: string): ConfigFieldIssue | null {
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    return {
      field: "contextWindowTokens",
      error: "Context window must be a positive integer token count, e.g. 128000.",
    };
  }
  return null;
}

/**
 * 校验自定义 baseURL：去掉首尾空白后非空、可解析为绝对 http/https URL。
 * 允许本地开发端点（如 `http://localhost:8080/v1`）；相对路径、裸数字
 * 和非 http(s) 协议会被拒绝。
 */
export function validateBaseURL(raw: string): ConfigFieldIssue | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { field: "baseURL", error: "Base URL must not be empty. Enter an absolute http(s) URL." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      field: "baseURL",
      error: `"${trimmed}" is not a valid absolute URL. Enter something like https://api.example.com/v1 or http://localhost:8080/v1.`,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      field: "baseURL",
      error: `Base URL must use http or https (got "${parsed.protocol.replace(":", "")}").`,
    };
  }

  return null;
}

export interface ProviderEntryInput {
  modelName: string;
  apiKey: string;
  contextWindowTokens: string;
  /** 仅对要求自定义 baseURL 的选项生效。 */
  customBaseURL?: string;
}

export type ProviderEntryResult = { ok: true; entry: ModelEntry } | { ok: false; issues: ConfigFieldIssue[] };

/**
 * 由选中的 provider 选项加用户输入映射到配置项的纯函数。
 * 首次运行 wizard 与 `config model add` 共用它，保证两条流程不会分叉。
 */
export function buildEntryFromProviderOption(option: ProviderOption, input: ProviderEntryInput): ProviderEntryResult {
  const issues: ConfigFieldIssue[] = [];

  const modelNameIssue = validateModelName(input.modelName);
  if (modelNameIssue) issues.push(modelNameIssue);

  const apiKeyIssue = validateApiKey(input.apiKey);
  if (apiKeyIssue) issues.push(apiKeyIssue);

  const contextWindowIssue = validateContextWindowTokens(input.contextWindowTokens);
  if (contextWindowIssue) issues.push(contextWindowIssue);

  let baseURL: string;
  if (option.requiresCustomBaseURL) {
    const baseURLIssue = validateBaseURL(input.customBaseURL ?? "");
    if (baseURLIssue) {
      issues.push(baseURLIssue);
      baseURL = "";
    } else {
      baseURL = (input.customBaseURL ?? "").trim();
    }
  } else {
    baseURL = option.officialBaseURL!;
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    entry: {
      id: crypto.randomUUID(),
      name: input.modelName.trim(),
      model: input.modelName.trim(),
      baseURL,
      APIKey: input.apiKey.trim(),
      provider: option.providerType,
      contextWindowTokens: Number(input.contextWindowTokens.trim()),
      contextCompactionMode: "auto",
    },
  };
}

/**
 * 对用于展示的密钥脱敏：仅保留末尾少数几个字符可见，
 * 完整值绝不渲染进 UI 输出、日志或错误信息。
 */
export function maskSecret(secret: string, visibleSuffix = 8): string {
  if (secret.length <= visibleSuffix) {
    return "*".repeat(Math.max(secret.length, 1));
  }
  return "*".repeat(secret.length - visibleSuffix) + secret.slice(-visibleSuffix);
}
