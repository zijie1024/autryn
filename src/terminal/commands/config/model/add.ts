import type { Command } from "commander";

import { runModelWizard } from "@/terminal/bootstrap";
import {
  ensureAutrynHomeDirectory,
  ensureAutrynHomeEnv,
  getConfigFilePath,
  isAutrynSetupComplete,
  loadConfig,
  saveConfig,
} from "@/terminal/config";

export function registerAddCommand(parent: Command): void {
  parent
    .command("add")
    .description("Add a new model configuration")
    .action(async () => {
      ensureAutrynHomeEnv();
      ensureAutrynHomeDirectory();

      const entry = await runModelWizard();

      if (isAutrynSetupComplete()) {
        const config = loadConfig();
        saveConfig({ ...config, models: [...config.models, entry] });
      } else {
        saveConfig({
          models: [entry],
          agentGroups: [{
            id: "default-coding",
            name: "Default Coding",
            entryAgentId: "code",
            defaults: { modelConfigId: entry.id },
            agents: [{ id: "code", name: "Code", description: "Handles the current coding task.", delegates: [], handoffs: [] }],
          }],
          defaultAgentGroupId: "default-coding",
          defaultExecutionMode: "execute",
        });
      }
      console.info(`\nModel "${entry.name}" added. Config saved to: ${getConfigFilePath()}`);
    });
}
