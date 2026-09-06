import type { Command } from "commander";

import { ensureAutrynHomeEnv, findModelEntry, isAutrynSetupComplete, loadConfig, saveConfig } from "@/terminal/config";

import { promptSelectModelName } from "./prompt-select-model";

export function registerRemoveCommand(parent: Command): void {
  parent
    .command("remove [model_name]")
    .description("Remove a model configuration by name")
    .action(async (modelName?: string) => {
      ensureAutrynHomeEnv();

      if (!isAutrynSetupComplete()) {
        console.error("No configuration found. Nothing to remove.");
        process.exit(1);
      }

      const config = loadConfig();
      if (config.models.length === 1) {
        console.error("Cannot remove the last model. At least one model must be configured.");
        process.exit(1);
      }

      const resolvedName =
        modelName ??
        (await promptSelectModelName(config, { actionLabel: "remove" }).catch((err: unknown) => {
          console.error(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }));

      const selected = findModelEntry(config, resolvedName);
      const idx = selected ? config.models.findIndex((m) => m.id === selected.id) : -1;
      if (idx === -1) {
        console.error(`Model "${resolvedName}" not found.`);
        process.exit(1);
      }

      const removed = config.models[idx]!;
      const referencedByGroup = config.agentGroups.some((group) =>
        group.defaults?.modelConfigId === removed.id || group.agents.some((agent) => agent.modelConfigId === removed.id),
      );
      const referencedByCompaction = config.contextCompaction?.summaryModelConfigId === removed.id;
      if (referencedByGroup || referencedByCompaction) {
        const references = [
          ...(referencedByGroup ? ["an Agent Group"] : []),
          ...(referencedByCompaction ? ["context compaction"] : []),
        ].join(" and ");
        console.error(
          `Model "${removed.name}" is referenced by ${references}. Rebind the references before removing it.`,
        );
        process.exit(1);
      }
      config.models.splice(idx, 1);

      saveConfig(config);
      console.info(`Model "${removed.name}" removed.`);
    });
}
