import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { NonSystemMessage } from "@/core";
import { convertToAnthropicMessages } from "@/providers/anthropic/utils";
import { convertToOpenAIMessages } from "@/providers/openai/utils";
import { sanitizeMessageForPersistence } from "@/sessions/session-schema";

const transcript: NonSystemMessage[] = [
  { role: "user", content: [{ type: "text", text: "Find the file" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "private reasoning", signature: "anthropic-signature" },
      { type: "text", text: "I will inspect it." },
      {
        type: "tool_use",
        id: "toolu_123",
        name: "read_file",
        input: { path: path.join(process.cwd(), "README.md") },
      },
    ],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "README content" }],
  },
];

describe("session canonical transcript provider projection", () => {
  test("OpenAI to OpenAI projection keeps text and tools after persistence sanitization", () => {
    const persisted = transcript.map(sanitizeMessageForPersistence);
    const projected = convertToOpenAIMessages(persisted);
    expect(JSON.stringify(projected)).toContain("read_file");
    expect(JSON.stringify(projected)).toContain("toolu_123");
    expect(JSON.stringify(projected)).not.toContain("private reasoning");
    expect(JSON.stringify(projected)).not.toContain("anthropic-signature");
  });

  test("Anthropic to Anthropic projection keeps text and tools after persistence sanitization", () => {
    const persisted = transcript.map(sanitizeMessageForPersistence);
    const projected = convertToAnthropicMessages(persisted);
    expect(JSON.stringify(projected)).toContain("read_file");
    expect(JSON.stringify(projected)).toContain("toolu_123");
    expect(JSON.stringify(projected)).not.toContain("private reasoning");
    expect(JSON.stringify(projected)).not.toContain("anthropic-signature");
  });

  test("OpenAI to Anthropic and Anthropic to OpenAI use the same canonical persisted transcript", () => {
    const persisted = transcript.map(sanitizeMessageForPersistence);
    const openai = convertToOpenAIMessages(persisted);
    const anthropic = convertToAnthropicMessages(persisted);

    expect(JSON.stringify(openai)).toContain("README content");
    expect(JSON.stringify(anthropic)).toContain("README content");
    expect(persisted[1]?.role).toBe("assistant");
    expect(persisted[1]?.content.some((content) => content.type === "thinking")).toBe(false);
    expect(
      transcript[1]?.role === "assistant" && transcript[1].content.some((content) => content.type === "thinking"),
    ).toBe(true);
  });
});
