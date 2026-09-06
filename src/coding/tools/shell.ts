import z from "zod";

import { defineTool } from "@/core";

export type ShellPlatform = "win32" | "posix";

export type ShellToolOptions = {
  /** 子 shell 运行的工作目录，默认取进程 cwd。 */
  cwd?: string;
  /** 用于测试时覆盖平台判断。 */
  platform?: ShellPlatform;
  /** spawn 实现；可注入，以便测试断言命令参数。 */
  spawn?: typeof Bun.spawn;
};

export function createShellTool(options: ShellToolOptions = {}) {
  const { cwd, platform = process.platform === "win32" ? "win32" : "posix", spawn = Bun.spawn } = options;
  const shell = platform === "win32" ? "powershell.exe" : "/bin/sh";
  const shellArgs = platform === "win32"
    ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]
    : ["-c"];

  return defineTool({
    name: "shell",
    description: platform === "win32" ? "Execute a PowerShell command" : "Execute a POSIX shell command",
    parameters: z.object({
      description: z
        .string()
        .describe("Explain why you want to execute the command. Always place `description` as the first parameter."),
      command: z.string().describe("The shell command to execute."),
    }),
    effect: {
      kind: "mutation",
      scope: "system",
      reversible: false,
      description: "May modify local process, filesystem, system, or external state.",
    },
    execute: async ({ command }, context) => {
      const proc = spawn({
        cmd: [shell, ...shellArgs, command],
        stdout: "pipe",
        stderr: "pipe",
        ...(cwd ? { cwd } : {}),
      });

      if (context.signal) {
        const onAbort = () => proc.kill();
        context.signal.addEventListener("abort", onAbort, { once: true });
        void proc.exited.then(() => context.signal?.removeEventListener("abort", onAbort));
      }

      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return `Error: Command ${command} failed with exit code ${exitCode}: ${stderr}`;
      }
      return output;
    },
    preview: async ({ command }) => ({
      status: "indeterminate",
      summary: "Command was not executed. Full shell effects cannot be predicted reliably.",
      operations: [
        {
          action: "run_shell_command",
          resource: { kind: "process", identifier: cwd ?? process.cwd() },
          description: command,
          reversible: false,
        },
      ],
      warnings: ["Shell preview is static and does not start a process."],
      confidence: "unknown",
      details: { command, cwd: cwd ?? process.cwd(), shell },
    }),
  });
}
