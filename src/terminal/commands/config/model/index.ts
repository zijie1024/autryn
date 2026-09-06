import type { Command } from "commander";

import { registerAddCommand } from "./add";
import { registerListCommand } from "./list";
import { registerRemoveCommand } from "./remove";
import { registerSetDefaultCommand } from "./set-default";

export function registerModelCommands(parent: Command): void {
  const model = parent.command("model").description("Manage model configurations");
  registerAddCommand(model);
  registerListCommand(model);
  registerRemoveCommand(model);
  registerSetDefaultCommand(model);
}
