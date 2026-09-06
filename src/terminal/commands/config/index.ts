import type { Command } from "commander";

import { registerAgentGroupCommands } from "./agent-group";
import { registerModelCommands } from "./model";

export function registerConfigCommands(program: Command): void {
  const config = program.command("config").description("Manage Autryn configuration");
  registerModelCommands(config);
  registerAgentGroupCommands(config);
}
