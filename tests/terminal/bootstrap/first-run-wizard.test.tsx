import { describe, expect, test } from "bun:test";

import { ExecutionModeScreen } from "@/terminal/bootstrap/first-run-wizard";

import { nextRenderTick, renderWithMemoryStreams } from "../tui/test-render";

describe("ExecutionModeScreen", () => {
  test("selects dry-run as the default mode", async () => {
    let selected: "execute" | "dry_run" | undefined;
    const { instance, stdout, stdin } = renderWithMemoryStreams(
      <ExecutionModeScreen onComplete={(mode) => (selected = mode)} onAbort={() => {}} />,
    );
    await nextRenderTick();

    expect(stdout.output).toContain("Execute");
    expect(stdout.output).toContain("Dry-run");

    stdin.push("\u001B[B");
    await nextRenderTick();
    stdin.push("\r");
    await nextRenderTick();

    expect(selected).toBe("dry_run");
    instance.unmount();
  });
});
