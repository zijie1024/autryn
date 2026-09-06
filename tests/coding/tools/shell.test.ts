import { describe, expect, test } from "bun:test";

import { createShellTool } from "@/coding/tools/shell";

/** A spawn double that captures cmd/cwd and returns scripted process output. */
function fakeSpawn(result: { exitCode: number; stdout?: string; stderr?: string }) {
  const calls: Array<{ cmd: string[]; cwd?: string }> = [];
  const encode = (text: string) => new TextEncoder().encode(text);

  const spawn = ((options: { cmd: string[]; cwd?: string }) => {
    calls.push({ cmd: options.cmd, cwd: options.cwd });
    const stdout = new ReadableStream({
      start(controller) {
        controller.enqueue(encode(result.stdout ?? ""));
        controller.close();
      },
    });
    const stderr = new ReadableStream({
      start(controller) {
        controller.enqueue(encode(result.stderr ?? ""));
        controller.close();
      },
    });
    return {
      stdout,
      stderr,
      exited: Promise.resolve(result.exitCode),
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as typeof Bun.spawn;

  return { calls, spawn };
}

describe("createShellTool", () => {
  test("uses POSIX shell arguments on macOS and Linux", async () => {
    const { calls, spawn } = fakeSpawn({ exitCode: 0, stdout: "ok\n" });
    const tool = createShellTool({ platform: "posix", spawn });

    const result = await tool.execute({ description: "run", command: "echo hi" });

    expect(result).toBe("ok\n");
    expect(calls).toEqual([{ cmd: ["/bin/sh", "-c", "echo hi"], cwd: undefined }]);
  });

  test("uses PowerShell arguments on Windows", async () => {
    const { calls, spawn } = fakeSpawn({ exitCode: 0, stdout: "ok\n" });
    const tool = createShellTool({ platform: "win32", spawn });

    await tool.execute({ description: "run", command: "Write-Output hi" });

    expect(calls).toEqual([{
      cmd: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output hi"],
      cwd: undefined,
    }]);
  });

  test("forwards the coding agent cwd to the spawned shell", async () => {
    const { calls, spawn } = fakeSpawn({ exitCode: 0, stdout: "" });
    const tool = createShellTool({ cwd: "D:\\work", spawn });

    await tool.execute({ description: "run", command: "pwd" });

    expect(calls[0]?.cwd).toBe("D:\\work");
  });

  test("returns an error string when the command exits non-zero", async () => {
    const { spawn } = fakeSpawn({ exitCode: 42, stderr: "nope" });
    const tool = createShellTool({ spawn });

    const result = await tool.execute({ description: "fail", command: "exit 42" });

    expect(result).toMatch(/^Error: Command exit 42 failed with exit code 42: nope$/);
  });
});
