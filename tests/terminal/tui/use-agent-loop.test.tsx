import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";

import type { AssistantMessage, NonSystemMessage, UserMessage } from "@/core";
import type { Agent } from "@/runtime";
import type { PromptSubmission } from "@/terminal/tui/command-registry";
import { AgentLoopProvider, useAgentLoop } from "@/terminal/tui/hooks/use-agent-loop";

import { nextRenderTick, renderWithMemoryStreams } from "./test-render";

function createFakeAgent() {
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
      const reply: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      };
      this.messages.push(reply);
      yield { type: "message", message: reply };
    },
  };
  return agent as unknown as Agent & { messages: NonSystemMessage[] };
}

let tempHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "autryn-agent-loop-"));
  previousHome = Bun.env.AUTRYN_HOME;
  Bun.env.AUTRYN_HOME = tempHome;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete Bun.env.AUTRYN_HOME;
  } else {
    Bun.env.AUTRYN_HOME = previousHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("AgentLoopProvider session behavior", () => {
  test("new provider starts with an empty transcript; /clear empties agent and TUI together and keeps history.txt", async () => {
    await writeFile(join(tempHome, "history.txt"), "prior input\n", "utf8");

    const agent = createFakeAgent();
    const probe = { messages: [] as NonSystemMessage[] };

    let submit: ((submission: PromptSubmission) => Promise<void>) | null = null;

    function Probe() {
      const { messages } = useAgentLoop();
      useEffect(() => {
        probe.messages = messages;
      }, [messages]);
      return null;
    }

    function Driver() {
      const { onSubmit } = useAgentLoop();
      useEffect(() => {
        submit = onSubmit;
      }, [onSubmit]);
      return null;
    }

    const { instance } = renderWithMemoryStreams(
      <AgentLoopProvider agent={agent} commands={[]}>
        <Probe />
        <Driver />
      </AgentLoopProvider>,
    );
    await nextRenderTick();

    // 新进程/新 provider：各处 transcript 均为空。
    expect(probe.messages).toEqual([]);
    expect(agent.messages).toEqual([]);

    // 正常回合：user + assistant 同时进入两份 transcript。
    expect(submit).not.toBeNull();
    await submit!({ text: "hello", requestedSkillName: null });
    await nextRenderTick(150);
    expect(probe.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant"]);

    // /clear：agent 与 TUI 的 transcript 都被清空，无分叉。
    await submit!({ text: "/clear", requestedSkillName: null });
    await nextRenderTick(150);
    expect(probe.messages).toEqual([]);
    expect(agent.messages).toEqual([]);

    // /clear 从不删除或改写磁盘上的输入历史。
    const history = await readFile(join(tempHome, "history.txt"), "utf8");
    expect(history).toBe("prior input\n");

    instance.unmount();
  });
});
