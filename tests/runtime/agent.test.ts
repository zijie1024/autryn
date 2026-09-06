import { describe, expect, test } from "bun:test";
import z from "zod";

import { defineTool, Model, type Tool, type UserMessage } from "@/core";
import { Agent } from "@/runtime/agent/agent";
import type { AgentEvent } from "@/runtime/events/agent-event";
import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import { createDeferred, createScriptedProvider, finalTextMessage, finalToolUseMessage } from "./fake-provider";

const userMessage: UserMessage = { role: "user", content: [{ type: "text", text: "go" }] };

function collect(events: AgentEvent[]) {
  return {
    messages: events.filter((e) => e.type === "message").map((e) => (e.type === "message" ? e.message : undefined)),
    progress: events.filter((e) => e.type === "progress"),
  };
}

function echoTool(): Tool {
  return defineTool({
    name: "echo_tool",
    description: "Echoes text back.",
    effect: { kind: "read", scope: "process", description: "Test tool." },
    parameters: z.object({ text: z.string() }),
    execute: async ({ text }) => `echo: ${text}`,
  });
}

async function drain(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("Agent loop", () => {
  test("single step: no tool calls ends the run after one model call", async () => {
    const { provider, calls } = createScriptedProvider([() => [finalTextMessage("done")]]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "system prompt", tools: [] });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    expect(calls.length).toBe(1);
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("assistant");
    expect(agent.messages.length).toBe(2); // user + assistant
    expect(agent.streaming).toBe(false);
    // system prompt 以 system 消息发送，不会存入 transcript。
    expect(calls[0]?.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "system prompt" }] });
    // transcript 的类型本身就是 NonSystemMessage[]：prompt 永远不会进入其中。
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  test("multi-step ReAct: tool_use -> tool_result -> final text", async () => {
    const { provider, calls } = createScriptedProvider([
      // 第 1 步：流式快照（progress）之后是最终的 tool 调用。
      () => [
        { role: "assistant", content: [{ type: "text", text: "thinking..." }], streaming: true },
        finalToolUseMessage([{ id: "call_1", name: "echo_tool", input: { text: "ping" } }]),
      ],
      // 第 2 步：断言 tool 结果到达 provider，然后结束。
      (index, params) => {
        const toolMessages = params.messages.filter((m) => m.role === "tool");
        expect(toolMessages.length).toBe(1);
        expect(toolMessages[0]?.content[0]?.type === "tool_result").toBe(true);
        if (toolMessages[0]?.content[0]?.type === "tool_result") {
          expect(toolMessages[0].content[0].tool_use_id).toBe("call_1");
          expect(toolMessages[0].content[0].content).toContain("echo: ping");
        }
        return [finalTextMessage("final answer")];
      },
    ]);

    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [echoTool()],
    });

    const events = await drain(agent.stream(userMessage));
    const { messages, progress } = collect(events);

    expect(calls.length).toBe(2);
    expect(messages.map((m) => m?.role)).toEqual(["assistant", "tool", "assistant"]);
    expect(progress.length).toBeGreaterThan(0); // streaming snapshots surface as progress events
    expect(progress[0]).toEqual({ type: "progress", subtype: "thinking" });
    expect(agent.messages.length).toBe(4); // user + assistant + tool + assistant
    expect(agent.streaming).toBe(false);
  });

  test("tool not found becomes an error observation the loop can continue from", async () => {
    const { provider, calls } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_ghost", name: "ghost_tool", input: {} }])],
      () => [finalTextMessage("recovered")],
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [echoTool()] });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    expect(calls.length).toBe(2);
    const toolMessage = messages[1];
    expect(toolMessage?.role).toBe("tool");
    const toolResult = toolMessage?.content[0];
    expect(toolResult?.type === "tool_result").toBe(true);
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("Tool ghost_tool not found");
      expect(JSON.parse(toolResult.content).ok).toBe(false);
    }
  });

  test("parallel tool calls in one step are appended in completion order", async () => {
    const slow = createDeferred<string>();
    const fast = createDeferred<string>();
    const seenSignals: Array<AbortSignal | undefined> = [];

    const makeTool = (name: string, deferred: { promise: Promise<string> }): Tool =>
      defineTool({
        name,
        description: "deferred test tool",
        effect: { kind: "read", scope: "process", description: "Test tool." },
        parameters: z.object({}),
        execute: async (_input, context) => {
          seenSignals.push(context.signal);
          return deferred.promise;
        },
      });

    const { provider } = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "call_slow", name: "slow_tool", input: {} },
          { id: "call_fast", name: "fast_tool", input: {} },
        ]),
      ],
      () => [finalTextMessage("done")],
    ]);

    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [makeTool("slow_tool", slow), makeTool("fast_tool", fast)],
    });

    const stream = agent.stream(userMessage);
    const first = await stream.next(); // assistant tool_use message
    expect(first.done).toBe(false);

    // 恢复生成器会启动 _act：两个 tool 并行运行，且都在完成前收到该次运行的 AbortSignal。
    const fastEventPromise = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the resumed generator reach _act
    expect(seenSignals.length).toBe(2);
    expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    expect(seenSignals[0]).toBe(seenSignals[1]);

    // 先 resolve 后启动的 tool：完成顺序优先于调用顺序。
    fast.resolve("fast result");
    const fastEvent = await fastEventPromise;
    slow.resolve("slow result");
    const slowEvent = await stream.next();
    const rest = await drain(stream);

    const toolEvents = [fastEvent.value, slowEvent.value, ...rest]
      .filter((e): e is Extract<AgentEvent, { type: "message" }> => e?.type === "message")
      .map((e) => e.message)
      .filter((m) => m.role === "tool");
    const ids = toolEvents.map((m) => (m?.content[0]?.type === "tool_result" ? m.content[0].tool_use_id : null));
    expect(ids).toEqual(["call_fast", "call_slow"]);
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
  });

  test("maxSteps exhaustion throws and leaves the agent ready for a new run", async () => {
    const toolStep = () => [finalToolUseMessage([{ id: "call_x", name: "echo_tool", input: { text: "x" } }])];
    const { provider } = createScriptedProvider([toolStep, toolStep, () => [finalTextMessage("second run done")]]);
    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [echoTool()],
      maxSteps: 2,
    });

    await expect(drain(agent.stream(userMessage))).rejects.toThrow("Maximum number of steps reached");
    expect(agent.streaming).toBe(false);

    // 守卫已释放：同一 agent 上的新一轮运行正常完成。
    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);
    expect(messages.at(-1)?.role === "assistant").toBe(true);
    expect(agent.streaming).toBe(false);
  });

  test("model errors propagate and release the streaming guard", async () => {
    const { provider } = createScriptedProvider([
      () => {
        throw new Error("provider exploded");
      },
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [] });

    await expect(drain(agent.stream(userMessage))).rejects.toThrow("provider exploded");
    expect(agent.streaming).toBe(false);
  });

  test("an empty model stream is a run failure, not a silent success", async () => {
    const { provider } = createScriptedProvider([() => []]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [] });

    await expect(drain(agent.stream(userMessage))).rejects.toThrow("Model stream ended without producing a message");
    expect(agent.streaming).toBe(false);
  });

  test("tool errors become error observations and the run continues", async () => {
    const failingTool = defineTool({
      name: "failing_tool",
      description: "always throws",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => {
        throw new Error("boom");
      },
    });
    const { provider, calls } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_fail", name: "failing_tool", input: {} }])],
      () => [finalTextMessage("handled")],
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [failingTool] });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    expect(calls.length).toBe(2);
    const toolResult = messages[1]?.content[0];
    expect(toolResult?.type === "tool_result").toBe(true);
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("boom");
      expect(JSON.parse(toolResult.content).ok).toBe(false);
    }
  });

  test("abort() cancels the run: the signal reaches tools and no messages are appended after abort", async () => {
    const deferred = createDeferred<string>();
    let toolSignal: AbortSignal | undefined;
    const hangingTool = defineTool({
      name: "hanging_tool",
      description: "never resolves on its own",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async (_input, context) => {
        toolSignal = context.signal;
        return deferred.promise;
      },
    });
    const { provider } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_hang", name: "hanging_tool", input: {} }])],
      () => [finalTextMessage("never reached")],
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [hangingTool] });

    const stream = agent.stream(userMessage);
    const first = await stream.next(); // assistant tool_use message
    expect(first.done).toBe(false);

    // 恢复以便运行进入 tool 执行，然后在中途中止。
    const pendingToolEvent = stream.next();
    agent.abort();

    await expect(pendingToolEvent).rejects.toMatchObject({ name: "AbortError" });
    expect(toolSignal?.aborted).toBe(true);
    expect(agent.streaming).toBe(false);
    // 只追加了 user + assistant(tool_use)；挂起的 tool 结果从未落地。
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // 孤儿 tool 的迟到结算不得扩展 transcript。
    deferred.resolve("late result");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.messages.length).toBe(2);
  });

  test("invalid tool input is rejected at the execution boundary without invoking the tool", async () => {
    let toolInvoked = false;
    const strictTool = defineTool({
      name: "strict_tool",
      description: "requires { text: string }",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({ text: z.string() }),
      execute: async ({ text }) => {
        toolInvoked = true;
        return `got ${text}`;
      },
    });
    const { provider, calls } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_bad", name: "strict_tool", input: { text: 42 } }])],
      (index, params) => {
        // model 观察到结构化校验错误，可以恢复。
        const toolResult = params.messages.at(-1)?.content[0];
        expect(toolResult?.type === "tool_result" ? JSON.parse(toolResult.content) : null).toMatchObject({
          ok: false,
          code: "INVALID_TOOL_INPUT",
        });
        return [finalTextMessage("recovered")];
      },
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [strictTool] });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    expect(toolInvoked).toBe(false);
    expect(calls.length).toBe(2);
    const toolResult = messages[1]?.content[0];
    expect(toolResult?.type === "tool_result").toBe(true);
    if (toolResult?.type === "tool_result") {
      expect(JSON.parse(toolResult.content)).toMatchObject({ ok: false, code: "INVALID_TOOL_INPUT" });
      expect(toolResult.content).toContain("strict_tool");
    }
  });

  test("valid input reaches the tool after schema transformation", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const defaultingTool = defineTool({
      name: "defaulting_tool",
      description: "fills in defaults",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({ n: z.number().default(5) }),
      execute: async (input) => {
        seen.push(input as Record<string, unknown>);
        return "ok";
      },
    });
    const { provider } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_1", name: "defaulting_tool", input: {} }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [defaultingTool] });

    await drain(agent.stream(userMessage));
    expect(seen).toEqual([{ n: 5 }]);
  });

  test("a second concurrent stream on the same agent is rejected", async () => {
    const deferred = createDeferred<string>();
    const hangingTool = defineTool({
      name: "hanging_tool",
      description: "keeps the first run busy",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => deferred.promise,
    });
    const { provider } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_1", name: "hanging_tool", input: {} }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({ name: "t", model: new Model("m", provider), prompt: "p", tools: [hangingTool] });

    const stream = agent.stream(userMessage);
    await stream.next(); // run is now in flight

    // 异步生成器体在首次 next() 时才开始执行，因此守卫在那里显现。
    const second = agent.stream(userMessage);
    await expect(second.next()).rejects.toThrow("Agent is already streaming");

    deferred.resolve("unblock");
    await drain(stream);
  });
});

describe("Agent middleware", () => {
  test("hooks run sequentially in array order and partial updates merge", async () => {
    const trace: string[] = [];
    const first: AgentMiddleware = {
      beforeAgentRun: async () => {
        trace.push("first.beforeAgentRun");
      },
      beforeAgentStep: async () => {
        trace.push("first.beforeAgentStep");
      },
      beforeModel: async ({ modelContext }) => {
        trace.push("first.beforeModel");
        return { prompt: `${modelContext.prompt}|first` };
      },
      afterModel: async () => {
        trace.push("first.afterModel");
      },
      beforeToolUse: async () => {
        trace.push("first.beforeToolUse");
      },
      afterToolUse: async () => {
        trace.push("first.afterToolUse");
      },
      afterAgentStep: async () => {
        trace.push("first.afterAgentStep");
      },
      afterAgentRun: async () => {
        trace.push("first.afterAgentRun");
      },
    };
    const second: AgentMiddleware = {
      beforeModel: async ({ modelContext }) => {
        trace.push("second.beforeModel");
        expect(modelContext.prompt).toBe("base|first"); // sees first middleware's merge
        return { prompt: `${modelContext.prompt}|second` };
      },
      beforeToolUse: async () => {
        trace.push("second.beforeToolUse");
      },
      afterToolUse: async () => {
        trace.push("second.afterToolUse");
      },
    };

    const { provider, calls } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_1", name: "echo_tool", input: { text: "x" } }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "base",
      tools: [echoTool()],
      middlewares: [first, second],
    });

    await drain(agent.stream(userMessage));

    expect(trace).toEqual([
      "first.beforeAgentRun",
      "first.beforeAgentStep",
      "first.beforeModel",
      "second.beforeModel",
      "first.afterModel",
      "first.beforeToolUse",
      "second.beforeToolUse",
      "first.afterToolUse",
      "second.afterToolUse",
      "first.afterAgentStep",
      "first.beforeAgentStep",
      "first.beforeModel",
      "second.beforeModel",
      "first.afterModel",
      "first.afterAgentRun",
    ]);
    // 合并后的 prompt 才是 provider 看到的；agent 存储的 prompt 保持不变。
    expect(calls[0]?.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "base|first|second" }] });
    expect(agent.prompt).toBe("base");
  });

  test("beforeToolUse skip bypasses the tool and uses the skip result", async () => {
    let toolInvoked = false;
    const guardedTool = defineTool({
      name: "guarded_tool",
      description: "guarded",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => {
        toolInvoked = true;
        return "should never run";
      },
    });
    const skipping: AgentMiddleware = {
      beforeToolUse: async () => ({
        action: "reject",
        result: {
          ok: false,
          summary: "skipped by middleware",
          error: "skipped by middleware",
          code: "TOOL_REJECTED",
        },
      }),
    };
    const { provider } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_1", name: "guarded_tool", input: {} }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [guardedTool],
      middlewares: [skipping],
    });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    expect(toolInvoked).toBe(false);
    const toolResult = messages[1]?.content[0];
    expect(toolResult?.type === "tool_result").toBe(true);
    if (toolResult?.type === "tool_result") {
      expect(toolResult.content).toContain("skipped by middleware");
    }
  });

  test("a structured skip result (e.g. user denial) reaches the transcript as an error observation", async () => {
    const denying: AgentMiddleware = {
      beforeToolUse: async () => ({
        action: "reject",
        result: {
          ok: false,
          summary: "User denied execution of tool: guarded_tool.",
          error: "User denied execution of tool: guarded_tool.",
          code: "TOOL_USE_DENIED",
        },
      }),
    };
    const guardedTool = defineTool({
      name: "guarded_tool",
      description: "guarded",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => "must never run",
    });
    const { provider } = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "call_1", name: "guarded_tool", input: {} }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [guardedTool],
      middlewares: [denying],
    });

    const events = await drain(agent.stream(userMessage));
    const { messages } = collect(events);

    const toolResult = messages[1]?.content[0];
    expect(toolResult?.type === "tool_result").toBe(true);
    if (toolResult?.type === "tool_result") {
      // 拒绝不得在 transcript 中被规范化为 ok:true 的成功。
      expect(JSON.parse(toolResult.content)).toMatchObject({ ok: false, code: "TOOL_USE_DENIED" });
    }
  });

  test("a throwing middleware aborts the run and releases the streaming guard", async () => {
    const broken: AgentMiddleware = {
      beforeModel: async () => {
        throw new Error("middleware exploded");
      },
    };
    const { provider } = createScriptedProvider([() => [finalTextMessage("unreachable")]]);
    const agent = new Agent({
      name: "t",
      model: new Model("m", provider),
      prompt: "p",
      tools: [],
      middlewares: [broken],
    });

    await expect(drain(agent.stream(userMessage))).rejects.toThrow("middleware exploded");
    expect(agent.streaming).toBe(false);
  });
});
