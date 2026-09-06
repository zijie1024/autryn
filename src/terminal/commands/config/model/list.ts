import type { Command } from "commander";

import { ensureAutrynHomeEnv, getDefaultModelEntry, isAutrynSetupComplete, loadConfig } from "@/terminal/config";

export function registerListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List all configured models")
    .action(() => {
      ensureAutrynHomeEnv();

      if (!isAutrynSetupComplete()) {
        console.info("No models configured. Run `autryn config model add` to add one.");
        return;
      }

      const config = loadConfig();
      if (config.models.length === 0) {
        console.info("No models configured.");
        return;
      }

      const defaultEntry = getDefaultModelEntry(config);
      console.info(`Default model: ${defaultEntry?.name ?? "(none)"}\n`);
      console.info("Configured models:\n");
      for (const [i, m] of config.models.entries()) {
        const isDefault = defaultEntry ? defaultEntry.id === m.id : false;
        console.info(`  ${i + 1}. ${m.name}${isDefault ? " (default)" : ""}`);
        console.info(`     id: ${m.id}`);
        console.info(`     model: ${m.model}`);
        console.info(`     baseURL: ${safeDisplayBaseURL(m.baseURL)}`);
        console.info(`     API Key: ****${m.APIKey.slice(-4)}`);
        console.info();
      }
      console.info(`\nThe default model is \`${defaultEntry?.name ?? "(none)"}\`. To change the default model, run:
      \n  autryn config model set-default <model_name>\n`);
    });
}

function safeDisplayBaseURL(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?..." : "";
    url.hash = "";
    return url.toString();
  } catch {
    return "(invalid URL)";
  }
}
