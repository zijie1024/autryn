import type { Command } from "commander";

import { ensureAutrynHomeEnv, loadConfig } from "@/terminal/config";

export function registerAgentGroupCommands(parent: Command): void {
  const groups = parent.command("agent-group").description("Inspect and validate Agent Groups");

  groups.command("list").description("List configured Agent Groups").action(() => {
    ensureAutrynHomeEnv();
    const config = loadConfig();
    for (const group of config.agentGroups) {
      console.info(`${group.id}  ${group.name}${group.id === config.defaultAgentGroupId ? "  (default)" : ""}`);
    }
  });

  groups.command("show <group>").description("Show one Agent Group without Model credentials").action((groupId: string) => {
    ensureAutrynHomeEnv();
    const config = loadConfig();
    const group = config.agentGroups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error(`Agent Group "${groupId}" is not configured.`);
    console.info(JSON.stringify(group, null, 2));
  });

  groups.command("validate [group]").description("Validate Agent Group configuration and collaboration graph").action((groupId?: string) => {
    ensureAutrynHomeEnv();
    const config = loadConfig();
    if (groupId && !config.agentGroups.some((candidate) => candidate.id === groupId)) {
      throw new Error(`Agent Group "${groupId}" is not configured.`);
    }
    console.info(groupId ? `Agent Group "${groupId}" is valid.` : "All Agent Groups are valid.");
  });
}
