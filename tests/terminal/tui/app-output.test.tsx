import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import { useEffect } from "react";

import type { AssistantMessage, NonSystemMessage, UserMessage } from "@/core";
import type { Agent } from "@/runtime";
import type { SessionController } from "@/terminal/session";
import { App } from "@/terminal/tui/app";
import type { PromptSubmission } from "@/terminal/tui/command-registry";
import { MessageHistory } from "@/terminal/tui/components/message-history";
import { AgentLoopProvider, useAgentLoop } from "@/terminal/tui/hooks/use-agent-loop";

import { nextRenderTick, renderWithMemoryStreams } from "./test-render";

function createFakeAgent() {
  let replyIndex = 0;
  const agent = {
    model: { name: "fake-model" },
    messages: [] as NonSystemMessage[],
    clearMessages() {
      this.messages.length = 0;
    },
    abort() {},
    setRequestedSkillName(_name: string | null) {},
    async *stream(userMessage: UserMessage) {
      this.messages.push(userMessage);
      replyIndex++;
      const reply: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: `reply-${replyIndex}` }],
      };
      this.messages.push(reply);
      yield { type: "message", message: reply };
    },
  };
  return agent as unknown as Agent;
}

describe("App message output", () => {
  let tempHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "autryn-app-output-"));
    previousHome = Bun.env.AUTRYN_HOME;
    Bun.env.AUTRYN_HOME = tempHome;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete Bun.env.AUTRYN_HOME;
    else Bun.env.AUTRYN_HOME = previousHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  test("keeps completed assistant output visible after a new prompt is submitted", async () => {
    const agent = createFakeAgent();
    let submit: ((submission: PromptSubmission) => Promise<void>) | null = null;
    let currentMessages: NonSystemMessage[] = [];

    function Driver() {
      const { messages, onSubmit } = useAgentLoop();
      useEffect(() => {
        submit = onSubmit;
      }, [onSubmit]);
      useEffect(() => {
        currentMessages = messages;
      }, [messages]);
      return null;
    }

    const { instance, stdout } = renderWithMemoryStreams(
      <AgentLoopProvider agent={agent} commands={[]}>
        <App commands={[]} />
        <Driver />
      </AgentLoopProvider>,
    );
    await nextRenderTick();
    await submit!({ text: "hello", requestedSkillName: null });
    await nextRenderTick(200);
    await submit!({ text: "again", requestedSkillName: null });
    await nextRenderTick(200);

    expect(stdout.output).toContain("reply-1");
    expect(stdout.output).toContain("reply-2");
    expect(currentMessages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(JSON.stringify(currentMessages)).toContain("reply-1");
    expect(JSON.stringify(currentMessages)).toContain("reply-2");
    instance.unmount();
  });

  test("separates turns without adding space inside a turn", () => {
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ];
    const lines = renderToString(<MessageHistory messages={messages} todoSnapshots={new Map()} />).split("\n");

    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("first");
    expect(lines[1]).toContain("answer");
    expect(lines[2]?.trim()).toBe("");
    expect(lines[3]).toContain("second");
  });

  test("shows structured execution failures instead of only stopping the indicator", async () => {
    const messages: NonSystemMessage[] = [];
    const controller = {
      messages: () => messages,
      snapshot: () => ({}),
      runTurn: async (_text: string, options: { onMessage?: (message: NonSystemMessage) => void }) => {
        const userMessage: UserMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
        messages.push(userMessage);
        options.onMessage?.(userMessage);
        return {
          branchId: "branch",
          executionId: "execution",
          agentId: "default-coding",
          rootExecutionId: "execution",
          initialExecutionId: "execution",
          finalExecutionId: "execution",
          initialAgentId: "default-coding",
          finalAgentId: "default-coding",
          status: "failed",
          mode: "execute",
          handoffs: [],
          steps: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          durationMs: 0,
          error: { code: "MODEL_FAILED", message: "model unavailable", retryable: true },
        };
      },
    } as unknown as SessionController;
    let submit: ((submission: PromptSubmission) => Promise<void>) | null = null;

    function Driver() {
      const { onSubmit } = useAgentLoop();
      useEffect(() => {
        submit = onSubmit;
      }, [onSubmit]);
      return null;
    }

    const { instance, stdout } = renderWithMemoryStreams(
      <AgentLoopProvider sessionController={controller} commands={[]}>
        <App commands={[]} />
        <Driver />
      </AgentLoopProvider>,
    );
    await nextRenderTick();
    await submit!({ text: "hello", requestedSkillName: null });
    await nextRenderTick(200);

    expect(stdout.output).toContain("model unavailable");
    instance.unmount();
  });
});
