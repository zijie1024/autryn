import { readFileSync } from "node:fs";

import { parse as yamlParse } from "yaml";

import {
  ensureAutrynHomeDirectory,
  ensureAutrynHomeEnv,
  formatConfigLoadError,
  getConfigFilePath,
  isAutrynSetupComplete,
  loadConfig,
  saveConfig,
} from "@/terminal/config";

import { runFirstRunWizard } from "./first-run-wizard";

export async function validateIntegrity(): Promise<void> {
  ensureAutrynHomeEnv();

  // 当 `config.yaml` 存在但没有配置任何 model 时，仍需要进入 bootstrap。
  // 注意：`autrynConfigSchema` 要求 `models.length >= 1`，所以不能仅靠
  // `loadConfig()` 来检测「空 models」的情况。
  if (isAutrynSetupComplete()) {
    try {
      const config = loadConfig();
      if (config.models.length > 0) {
        return;
      }
      // 未来 schema 约束若变化，这里仍作为安全检查保留。
    } catch (err) {
      // 即使 schema 校验失败，也要能检测出 `models: []`。
      let modelsLen: number | undefined;
      try {
        const raw = readFileSync(getConfigFilePath(), "utf8");
        const parsed: unknown = yamlParse(raw);
        modelsLen = Array.isArray((parsed as { models?: unknown }).models)
          ? (parsed as { models: unknown[] }).models.length
          : undefined;
      } catch {
        // YAML 无法解析：按下面的无效配置处理。
      }

      if (modelsLen === 0) {
        // 尚未存储任何内容；bootstrap 可以安全地创建配置。
      } else {
        // 已存在无效配置：上报可操作、不含密钥的错误信息，
        // 而不是通过 wizard 悄悄改写用户的文件。
        console.error(formatConfigLoadError(err, getConfigFilePath()));
        process.exit(1);
      }
    }
    // 落入 bootstrap。
  }

  ensureAutrynHomeDirectory();
  try {
    const config = await runFirstRunWizard();
    saveConfig(config);
    console.info(`\n\nAutryn setup completed. Config saved to: ${getConfigFilePath()}\n\n`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
