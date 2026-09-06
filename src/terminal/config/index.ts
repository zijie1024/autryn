import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parse, stringify } from "yaml";
import { ZodError } from "zod";

import { getAutrynHomePath, getDefaultAutrynHome } from "@/sessions/home";

import type { AutrynConfig, ModelEntry } from "./schema";
import { autrynConfigSchema } from "./schema";

export type {
  AgentGroupConfig,
  AgentProfileConfig,
  AutrynConfig,
  CodingCapabilityPolicy,
  DelegationEdgeConfig,
  HandoffEdgeConfig,
  ModelEntry,
} from "./schema";
export { autrynConfigSchema, modelEntrySchema } from "./schema";

const CONFIG_FILENAME = "config.yaml";

export function getConfigFilePath(): string {
  return path.join(getAutrynHomePath(), CONFIG_FILENAME);
}

/** 当 autryn home 目录存在且 `config.yaml` 已就位时为 true。 */
export function isAutrynSetupComplete(): boolean {
  const home = getAutrynHomePath();
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    return false;
  }
  return existsSync(getConfigFilePath());
}

export function loadConfig(): AutrynConfig {
  const p = getConfigFilePath();
  const raw = readFileSync(p, "utf8");
  const parsed: unknown = parse(raw);
  return autrynConfigSchema.parse(parsed);
}

export function saveConfig(config: AutrynConfig): void {
  const validated = autrynConfigSchema.parse(config);
  const content = stringify(validated, { lineWidth: 0 });
  const target = getConfigFilePath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, target);
}

export function getDefaultModelEntry(config: AutrynConfig): ModelEntry | undefined {
  const group = config.agentGroups.find((candidate) => candidate.id === config.defaultAgentGroupId);
  const entry = group?.agents.find((candidate) => candidate.id === group.entryAgentId);
  const modelId = entry?.modelConfigId ?? group?.defaults?.modelConfigId;
  return config.models.find((model) => model.id === modelId);
}

export function findModelEntry(config: AutrynConfig, selector: string): ModelEntry | undefined {
  const trimmed = selector.trim();
  return config.models.find((model) => model.id === trimmed || model.name === trimmed);
}

/** 确保 `AUTRYN_HOME` 在磁盘上存在（递归 mkdir）。 */
export function ensureAutrynHomeDirectory(): void {
  mkdirSync(getAutrynHomePath(), { recursive: true });
}

/**
 * 把配置加载失败格式化为可操作的信息。只显示问题路径（如 `models.0.APIKey`），
 * 绝不显示配置值本身，避免 API 密钥经错误、日志或崩溃输出泄露。
 */
export function formatConfigLoadError(error: unknown, configPath: string): string {
  const lines = [`Autryn could not load the configuration at ${configPath}.`];
  if (error instanceof ZodError) {
    const paths = [...new Set(error.issues.map((issue) => issue.path.join(".") || "(root)"))];
    lines.push(`Invalid value(s) at: ${paths.join(", ")}.`);
  } else {
    lines.push("The file could not be parsed as YAML.");
  }
  lines.push("Edit the file to fix it, or delete it and run `autryn` again to redo first-time setup.");
  return lines.join("\n");
}

/** 若 `AUTRYN_HOME` 尚未设置，则设为默认路径。 */
export function ensureAutrynHomeEnv(): void {
  if (!process.env.AUTRYN_HOME?.trim()) {
    const p = getDefaultAutrynHome();
    process.env.AUTRYN_HOME = p;
    if (typeof Bun !== "undefined") {
      Bun.env.AUTRYN_HOME = p;
    }
  }
}
