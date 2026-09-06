import type { Command } from "commander";

import { registerConfigCommands } from "./config";
import { registerMemoryCommands } from "./memory";
import { registerSessionCommands } from "./session";

export function registerCommands(program: Command): void {
  registerConfigCommands(program);
  registerMemoryCommands(program);
  registerSessionCommands(program);
}
