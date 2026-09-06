import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline/promises";

import { getDefaultModelEntry, type AutrynConfig } from "@/terminal/config";

type PromptSelectModelNameOptions = {
  /** 界面中使用的简短动词短语，如 "remove" / "set as default"。 */
  actionLabel: string;
  /** 设置后，该 model 将不作为选项提供。 */
  excludeName?: string;
};

export async function promptSelectModelName(config: AutrynConfig, opts: PromptSelectModelNameOptions): Promise<string> {
  const models = config.models.filter((m) => m.name !== opts.excludeName);
  if (models.length === 0) {
    throw new Error("No models available to select.");
  }

  // Commander action 可能在 stdin 非 TTY 的上下文中被调用（如 stdin 被管道），
  // 但用户仍处于终端。可用时改用 /dev/tty，让交互式选择依然可用。
  const input = process.stdin.isTTY ? process.stdin : createReadStream("/dev/tty");
  const output = process.stdout.isTTY ? process.stdout : createWriteStream("/dev/tty");

  console.info("Configured models:\n");
  for (const [i, m] of models.entries()) {
    const isDefault = getDefaultModelEntry(config)?.id === m.id;
    console.info(`  ${i + 1}. ${m.name}${isDefault ? " (default)" : ""}`);
  }
  console.info();

  const rl = createInterface({ input, output });
  try {
    // 持续提示，直到拿到有效选择或 EOF。
    // readline/promises 在输入关闭时会抛错；这里把这种情况视为取消。
    while (true) {
      const raw = (await rl.question(`Select a model to ${opts.actionLabel} (1-${models.length}): `)).trim();
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= models.length) {
        return models[n - 1]!.name;
      }
      console.error(`Invalid selection "${raw}". Please enter a number between 1 and ${models.length}.`);
    }
  } finally {
    rl.close();
    // 若不得已打开了 /dev/tty 流，确保它们被关闭。
    if (input !== process.stdin) input.destroy();
    if (output !== process.stdout) output.end();
  }
}
