import { describe, expect, test } from "bun:test";

import type { Agent } from "@/runtime";
import { Header } from "@/terminal/tui/components/header";
import { AgentLoopProvider } from "@/terminal/tui/hooks/use-agent-loop";
import { AUTRYN_VERSION } from "@/terminal/version";

import { nextRenderTick, renderWithMemoryStreams } from "./test-render";

function fakeAgent(): Agent {
  return { model: { name: "fake-model" } } as unknown as Agent;
}

describe("Header", () => {
  test("renders name, version, model, directory and new-session note as plain text", async () => {
    const { instance, stdout } = renderWithMemoryStreams(
      <AgentLoopProvider agent={fakeAgent()}>
        <Header />
      </AgentLoopProvider>,
    );
    await nextRenderTick();
    const out = stdout.output;

    expect(out).toContain("Autryn");
    expect(out).toContain(`v${AUTRYN_VERSION}`);
    expect(out).toContain("Active model: fake-model");
    expect(out).toContain(`Directory: ${process.cwd()}`);
    expect(out).toContain("Session: New session");

    instance.unmount();
  });

  test("no longer contains the cat mascot art or Logo output", async () => {
    const { instance, stdout } = renderWithMemoryStreams(
      <AgentLoopProvider agent={fakeAgent()}>
        <Header />
      </AgentLoopProvider>,
    );
    await nextRenderTick();
    const out = stdout.output;

    for (const glyph of ["▋", "▐", "▛", "▜", "▝", "▘", "█"]) {
      expect(out).not.toContain(glyph);
    }

    instance.unmount();
  });
});
