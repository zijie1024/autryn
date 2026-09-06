import type { Command } from "commander";

import { ensureAutrynHomeEnv, findModelEntry, isAutrynSetupComplete, loadConfig, saveConfig } from "@/terminal/config";

import { promptSelectModelName } from "./prompt-select-model";

export function registerSetDefaultCommand(parent: Command): void {
  parent
    .command("set-default [model_name]")
    .description("Set the default Agent Group entry Agent model")
    .action(async (modelName?: string) => {
      ensureAutrynHomeEnv();

      if (!isAutrynSetupComplete()) {
        console.error("No configuration found. Run `autryn config model add` to add a model first.");
        process.exit(1);
      }

      const config = loadConfig();
      const resolvedName =
        modelName ??
        (await promptSelectModelName(config, { actionLabel: "set as default" }).catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }));

      const entry = findModelEntry(config, resolvedName);
      if (!entry) {
        console.error(`Model "${resolvedName}" not found.`);
        process.exit(1);
      }

      const group = config.agentGroups.find((candidate) => candidate.id === config.defaultAgentGroupId)!;
      const agent = group.agents.find((candidate) => candidate.id === group.entryAgentId)!;
      agent.modelConfigId = entry.id;
      saveConfig(config);
      console.info(`Default model set to "${entry.name}".`);
    });
}
