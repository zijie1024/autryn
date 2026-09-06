import { describe, expect, test } from "bun:test";

import { ModelWizard } from "@/terminal/bootstrap/model-wizard";

import { nextRenderTick, renderWithMemoryStreams } from "../tui/test-render";

describe("ModelWizard provider step", () => {
  test("offers exactly the four confirmed provider entries and no vendor presets", async () => {
    const { instance, stdout } = renderWithMemoryStreams(<ModelWizard onComplete={() => {}} onAbort={() => {}} />);
    await nextRenderTick();
    const out = stdout.output;

    expect(out).toContain("Anthropic (Official)");
    expect(out).toContain("OpenAI (Official)");
    expect(out).toContain("Anthropic-compatible (Custom)");
    expect(out).toContain("OpenAI-compatible (Custom)");

    for (const vendor of [
      "Volcengine",
      "Qwen",
      "Minimax",
      "GLM",
      "Zhipu",
      "Kimi",
      "Moonshot",
      "DeepSeek",
      "Aliyun",
      "Other",
    ]) {
      expect(out).not.toContain(vendor);
    }

    instance.unmount();
  });
});
