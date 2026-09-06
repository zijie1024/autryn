import { describe, expect, test } from "bun:test";
import z from "zod";

import { defineTool, Model, type ModelProvider, type ModelProviderInvokeParams } from "@/core";
import type { DelegateDefinition } from "@/runtime";
import { Agent, AgentRuntime } from "@/runtime";

import { createDeferred, createScriptedProvider, finalTextMessage, finalToolUseMessage } from "./fake-provider";

const user = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };

async function drainExecution(agent: Agent) {
  const execution = agent.execute(user);
  for await (const _event of execution.events) {
    // 排空事件流
  }
  return execution.result;
}

describe("AgentRuntime delegation", () => {
  test("execute() returns a completed structured result and safe tree snapshot", async () => {
    const { provider } = createScriptedProvider([() => [finalTextMessage("root done", 12)]]);
    const runtime = new AgentRuntime({ idFactory: () => "root-1", now: () => 100 });
    const agent = new Agent({ name: "root", model: new Model("m", provider), prompt: "p", runtime });

    const result = await drainExecution(agent);

    expect(result).toMatchObject({
      executionId: "root-1",
      rootExecutionId: "root-1",
      status: "completed",
      output: { text: "root done" },
      steps: 1,
      usage: { totalTokens: 12 },
    });
    const tree = runtime.getTree("root-1");
    expect(tree?.executions).toHaveLength(1);
    expect(tree?.executions[0]).not.toHaveProperty("messages");
  });

  test("delegate_task uses the same runtime and lets the parent continue from child output", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const modelCalls: Array<{ executionId: string; agentId: string; model: string }> = [];
    runtime.subscribe((event) => {
      if (event.type === "model_call") {
        modelCalls.push({ executionId: event.executionId, agentId: event.agentId, model: event.model });
      }
    });
    const childProvider = createScriptedProvider([
      (_, params) => {
        expect(params.messages.map((m) => m.role)).toEqual(["system", "user"]);
        expect(params.messages[1]?.content[0]?.type === "text" ? params.messages[1].content[0].text : "").toBe(
          "inspect this",
        );
        return [finalTextMessage("child answer", 8)];
      },
    ]);
    const parentProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.tools?.some((tool) => tool.name === "delegate_task")).toBe(true);
        return [
          finalToolUseMessage(
            [{ id: "d1", name: "delegate_task", input: { agent: "helper", task: "inspect this" } }],
            10,
          ),
        ];
      },
      (_index, params: ModelProviderInvokeParams) => {
        const toolMessage = params.messages.at(-1);
        expect(toolMessage?.role).toBe("tool");
        const content = toolMessage?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: true,
          data: { executionId: "child", status: "completed" },
        });
        return [finalTextMessage("parent final", 6)];
      },
    ]);
    const parent = new Agent({
      name: "parent",
      model: new Model("parent", parentProvider.provider),
      prompt: "parent prompt",
      runtime,
      delegates: [
        {
          name: "helper",
          description: "helper agent",
          create: () => ({
            name: "helper",
            model: new Model("child", childProvider.provider),
            prompt: "child prompt",
          }),
        },
      ],
    });

    const result = await drainExecution(parent);

    expect(result.status).toBe("completed");
    expect(result.output?.text).toBe("parent final");
    expect(runtime.getTree("root")?.executions.map((e) => [e.id, e.parentExecutionId, e.agentId, e.status])).toEqual([
      ["root", undefined, "parent", "completed"],
      ["child", "root", "helper", "completed"],
    ]);
    expect(modelCalls).toEqual([
      { executionId: "root", agentId: "parent", model: "parent" },
      { executionId: "child", agentId: "helper", model: "child" },
      { executionId: "root", agentId: "parent", model: "parent" },
    ]);
  });

  test("unknown delegate is a structured tool error and the parent can recover", async () => {
    const runtime = new AgentRuntime({ idFactory: () => "root", now: () => 100 });
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d1", name: "delegate_task", input: { agent: "missing", task: "x" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: false,
          code: "DELEGATE_NOT_FOUND",
        });
        return [finalTextMessage("recovered")];
      },
    ]);
    const agent = new Agent({
      model: new Model("m", provider.provider),
      prompt: "p",
      runtime,
      delegates: [
        {
          name: "known",
          description: "known",
          create: () => ({ model: new Model("m", provider.provider), prompt: "p" }),
        },
      ],
    });

    const result = await drainExecution(agent);
    expect(result.status).toBe("completed");
    expect(result.output?.text).toBe("recovered");
  });

  test("sibling child executions obey FIFO when per-parent concurrency is one", async () => {
    const ids = ["root", "child-a", "child-b"];
    const runtime = new AgentRuntime({
      idFactory: () => ids.shift()!,
      now: () => 100,
      limits: { maxConcurrentPerParent: 1 },
    });
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const starts: string[] = [];
    const childProvider = (label: string, deferred: ReturnType<typeof createDeferred<string>>): ModelProvider => ({
      async invoke() {
        throw new Error("unused");
      },
      async *stream() {
        starts.push(label);
        yield finalTextMessage(await deferred.promise);
      },
    });
    const parentProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "a", name: "delegate_task", input: { agent: "a", task: "A" } },
          { id: "b", name: "delegate_task", input: { agent: "b", task: "B" } },
        ]),
      ],
      () => [finalTextMessage("done")],
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      delegates: [
        {
          name: "a",
          description: "a",
          create: () => ({ model: new Model("a", childProvider("a", first)), prompt: "a" }),
        },
        {
          name: "b",
          description: "b",
          create: () => ({ model: new Model("b", childProvider("b", second)), prompt: "b" }),
        },
      ],
    });

    const execution = parent.execute(user);
    const done = (async () => {
      for await (const _event of execution.events) {
        // 排空事件流
      }
      return execution.result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(["a"]);
    first.resolve("first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(["a", "b"]);
    second.resolve("second");

    await expect(done).resolves.toMatchObject({ status: "completed" });
  });

  test("root cancellation cascades to a running child", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const hanging = createDeferred<string>();
    const childSignal: { current?: AbortSignal } = {};
    const hangingTool = defineTool({
      name: "hang",
      description: "hangs",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async (_input, context) => {
        childSignal.current = context.signal;
        return hanging.promise;
      },
    });
    const childProvider = createScriptedProvider([() => [finalToolUseMessage([{ id: "h", name: "hang", input: {} }])]]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "child", task: "work" } }])],
      () => [finalTextMessage("never")],
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      delegates: [
        {
          name: "child",
          description: "child",
          create: () => ({ model: new Model("child", childProvider.provider), prompt: "child", tools: [hangingTool] }),
          policy: { tools: { mode: "explicit", tools: [hangingTool] } },
        },
      ],
    });

    const stream = parent.stream(user);
    await stream.next();
    const pending = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    parent.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(childSignal.current?.aborted).toBe(true);
    expect(runtime.getTree("root")?.executions.find((e) => e.id === "child")?.status).toBe("cancelled");
  });

  test("recursive delegate names are rejected before creating a grandchild", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const childProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "again", name: "delegate_task", input: { agent: "same", task: "again" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: false,
          code: "RECURSION_NOT_ALLOWED",
        });
        return [finalTextMessage("child recovered")];
      },
    ]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "same", task: "child" } }])],
      () => [finalTextMessage("parent done")],
    ]);
    const definition: DelegateDefinition = {
      name: "same",
      description: "same",
      create: () => ({
        model: new Model("child", childProvider.provider),
        prompt: "child",
      }),
      policy: { delegates: [] },
    };
    definition.policy!.delegates = [definition];
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      delegates: [definition],
    });

    const result = await drainExecution(parent);
    expect(result.status).toBe("completed");
    expect(runtime.getTree("root")?.executions.map((e) => e.id)).toEqual(["root", "child"]);
  });

  test("nested delegation releases a waiting child permit so grandchildren can run under tree concurrency one", async () => {
    const ids = ["root", "child", "grandchild"];
    const runtime = new AgentRuntime({
      idFactory: () => ids.shift()!,
      now: () => Date.now(),
      limits: { maxConcurrentPerTree: 1, childTimeoutMs: 100 },
    });
    const grandchildProvider = createScriptedProvider([() => [finalTextMessage("grandchild done")]]);
    const childProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "g", name: "delegate_task", input: { agent: "grandchild", task: "leaf" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: true,
          data: { executionId: "grandchild", status: "completed" },
        });
        return [finalTextMessage("child done")];
      },
    ]);
    const childDefinition: DelegateDefinition = {
      name: "child",
      description: "child",
      create: () => ({ model: new Model("child", childProvider.provider), prompt: "child" }),
      policy: { delegates: [] },
    };
    const grandchildDefinition: DelegateDefinition = {
      name: "grandchild",
      description: "grandchild",
      create: () => ({ model: new Model("grandchild", grandchildProvider.provider), prompt: "grandchild" }),
    };
    childDefinition.policy!.delegates = [grandchildDefinition];
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "c", name: "delegate_task", input: { agent: "child", task: "middle" } }])],
      () => [finalTextMessage("root done")],
    ]);
    const root = new Agent({
      model: new Model("root", parentProvider.provider),
      prompt: "root",
      runtime,
      delegates: [childDefinition],
    });

    const result = await drainExecution(root);

    expect(result.status).toBe("completed");
    expect(runtime.getTree("root")?.executions.map((execution) => [execution.id, execution.status])).toEqual([
      ["root", "completed"],
      ["child", "completed"],
      ["grandchild", "completed"],
    ]);
  });

  test("child tools default to none unless a policy explicitly grants them", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const childProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.tools).toEqual([]);
        return [finalTextMessage("child done")];
      },
    ]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "child", task: "work" } }])],
      () => [finalTextMessage("parent done")],
    ]);
    const childTool = defineTool({
      name: "secret_tool",
      description: "should not be inherited by default",
      effect: { kind: "read", scope: "process", description: "Test tool." },
    parameters: z.object({}),
      execute: async () => "nope",
    });
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      tools: [childTool],
      delegates: [
        {
          name: "child",
          description: "child",
          create: () => ({ model: new Model("child", childProvider.provider), prompt: "child", tools: [childTool] }),
        },
      ],
    });

    await expect(drainExecution(parent)).resolves.toMatchObject({ status: "completed" });
  });

  test("configured tool policy uses the target configuration without inheriting parent tools", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const parentOnly = defineTool({
      name: "parent_only",
      description: "parent",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => "parent",
    });
    const targetOnly = defineTool({
      name: "target_only",
      description: "target",
      effect: { kind: "read", scope: "process", description: "Test tool." },
      parameters: z.object({}),
      execute: async () => "target",
    });
    const childProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.tools?.map((tool) => tool.name)).toEqual(["target_only"]);
        return [finalTextMessage("child done")];
      },
    ]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "child", task: "work" } }])],
      () => [finalTextMessage("parent done")],
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      tools: [parentOnly],
      delegates: [
        {
          name: "child",
          description: "child",
          create: () => ({
            model: new Model("child", childProvider.provider),
            prompt: "child",
            tools: [targetOnly],
          }),
          policy: { tools: { mode: "configured" } },
        },
      ],
    });

    await expect(drainExecution(parent)).resolves.toMatchObject({ status: "completed" });
  });

  test("inherited tool policy honors allow lists and deny priority", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const allowedTool = defineTool({
      name: "read_file",
      description: "allowed",
      effect: { kind: "read", scope: "process", description: "Test tool." },
    parameters: z.object({}),
      execute: async () => "allowed",
    });
    const deniedTool = defineTool({
      name: "shell",
      description: "denied",
      effect: { kind: "read", scope: "process", description: "Test tool." },
    parameters: z.object({}),
      execute: async () => "denied",
    });
    const childProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.tools?.map((tool) => tool.name)).toEqual(["read_file"]);
        return [finalTextMessage("child done")];
      },
    ]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "child", task: "work" } }])],
      () => [finalTextMessage("parent done")],
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      tools: [allowedTool, deniedTool],
      delegates: [
        {
          name: "child",
          description: "child",
          create: () => ({ model: new Model("child", childProvider.provider), prompt: "child" }),
          policy: { tools: { mode: "inherit", allow: ["read_file", "shell"], deny: ["shell"] } },
        },
      ],
    });

    await expect(drainExecution(parent)).resolves.toMatchObject({ status: "completed" });
  });

  test("child skills default to none and inherit only allowed immutable descriptors", async () => {
    const ids = ["root", "none-child", "inherit-child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const parentSkills = [
      { name: "alpha", description: "Alpha skill", path: "/skills/alpha/SKILL.md" },
      { name: "beta", description: "Beta skill", path: "/skills/beta/SKILL.md" },
    ];
    const noneChildProvider = createScriptedProvider([
      () => {
        return [finalTextMessage("none child done")];
      },
    ]);
    const inheritChildProvider = createScriptedProvider([() => [finalTextMessage("inherit child done")]]);
    const seenSkills: string[][] = [];
    const skillProbe = {
      beforeModel: async ({ agentContext }: { agentContext: { skills?: typeof parentSkills } }) => {
        seenSkills.push((agentContext.skills ?? []).map((skill) => skill.name));
      },
    };
    const parentProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "none", name: "delegate_task", input: { agent: "none-child", task: "none" } },
          { id: "inherit", name: "delegate_task", input: { agent: "inherit-child", task: "inherit" } },
        ]),
      ],
      () => [finalTextMessage("parent done")],
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      skills: parentSkills,
      delegates: [
        {
          name: "none-child",
          description: "none",
          create: () => ({
            model: new Model("none", noneChildProvider.provider),
            prompt: "none child",
            middlewares: [skillProbe],
          }),
        },
        {
          name: "inherit-child",
          description: "inherit",
          create: () => ({
            model: new Model("inherit", inheritChildProvider.provider),
            prompt: "inherit child",
            middlewares: [skillProbe],
          }),
          policy: { skills: { mode: "inherit", allow: ["alpha"] } },
        },
      ],
    });

    await expect(drainExecution(parent)).resolves.toMatchObject({ status: "completed" });
    expect(seenSkills).toEqual([[], ["alpha"]]);
    expect(parent.skills?.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  });

  test("child timeout becomes a structured error observation and late model output is ignored", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({
      idFactory: () => ids.shift()!,
      now: () => Date.now(),
      limits: { childTimeoutMs: 5 },
    });
    const late = createDeferred<string>();
    const childProvider: ModelProvider = {
      async invoke() {
        throw new Error("unused");
      },
      async *stream() {
        yield finalTextMessage(await late.promise);
      },
    };
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "slow", task: "wait" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: false,
          code: "EXECUTION_TIMEOUT",
        });
        return [finalTextMessage("parent recovered")];
      },
    ]);
    const parent = new Agent({
      model: new Model("parent", parentProvider.provider),
      prompt: "p",
      runtime,
      delegates: [
        {
          name: "slow",
          description: "slow",
          create: () => ({ model: new Model("slow", childProvider), prompt: "slow" }),
        },
      ],
    });

    const result = await drainExecution(parent);
    late.resolve("too late");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("completed");
    expect(result.output?.text).toBe("parent recovered");
    const child = runtime.getTree("root")?.executions.find((execution) => execution.id === "child");
    expect(child?.status).toBe("timed_out");
    expect(child?.steps).toBe(1);
  });

  test("programmatic delegate() uses the same definition registry and returns child result", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const rootRelease = createDeferred<string>();
    const rootProvider: ModelProvider = {
      async invoke() {
        throw new Error("unused");
      },
      async *stream() {
        yield finalTextMessage(await rootRelease.promise);
      },
    };
    const childProvider = createScriptedProvider([() => [finalTextMessage("child result")]]);
    const root = new Agent({
      model: new Model("root", rootProvider),
      prompt: "root",
      runtime,
      delegates: [
        {
          name: "helper",
          description: "helper",
          create: () => ({ model: new Model("child", childProvider.provider), prompt: "child" }),
        },
      ],
    });
    const rootExecution = root.execute(user);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const delegated = await runtime.delegate(rootExecution.currentExecution(), {
      delegate: "helper",
      task: "work",
      metadata: { secretish: "hidden" },
    });
    rootRelease.resolve("root done");
    await rootExecution.result;

    expect(delegated).toMatchObject({
      accepted: true,
      execution: { executionId: "child", status: "completed", output: { text: "child result" } },
    });
    const treeChild = runtime.getTree("root")?.executions.find((execution) => execution.id === "child");
    expect(treeChild).not.toHaveProperty("metadata");
  });

  test("tree token budget becomes a limit_exceeded terminal status", async () => {
    const runtime = new AgentRuntime({
      idFactory: () => "root",
      now: () => 100,
      limits: { maxTokensPerTree: 5 },
    });
    const provider = createScriptedProvider([() => [finalTextMessage("too much", 6)]]);
    const root = new Agent({ model: new Model("root", provider.provider), prompt: "root", runtime });

    const result = await drainExecution(root);

    expect(result).toMatchObject({
      status: "limit_exceeded",
      error: { code: "TOKEN_LIMIT_EXCEEDED" },
      usage: { totalTokens: 6 },
    });
    expect(runtime.getTree("root")?.executions[0]?.status).toBe("limit_exceeded");
  });

  test("child cancellation does not cancel an unrelated sibling", async () => {
    const ids = ["root", "child-a", "child-b"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const releaseA = createDeferred<string>();
    const releaseB = createDeferred<string>();
    let childAExecutionId = "";
    const childProvider = (label: string, deferred: ReturnType<typeof createDeferred<string>>): ModelProvider => ({
      async invoke() {
        throw new Error("unused");
      },
      async *stream() {
        if (label === "a") {
          const tree = runtime.getTree("root");
          childAExecutionId = tree?.executions.find((execution) => execution.delegateName === "a")?.id ?? "";
        }
        yield finalTextMessage(await deferred.promise);
      },
    });
    const parentProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "a", name: "delegate_task", input: { agent: "a", task: "A" } },
          { id: "b", name: "delegate_task", input: { agent: "b", task: "B" } },
        ]),
      ],
      (_index, params) => {
        const results = params.messages
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content[0]!.content));
        expect(results).toContainEqual(expect.objectContaining({ ok: false, code: "EXECUTION_CANCELLED" }));
        expect(results).toContainEqual(expect.objectContaining({ ok: true }));
        return [finalTextMessage("parent done")];
      },
    ]);
    const root = new Agent({
      model: new Model("root", parentProvider.provider),
      prompt: "root",
      runtime,
      delegates: [
        {
          name: "a",
          description: "a",
          create: () => ({ model: new Model("a", childProvider("a", releaseA)), prompt: "a" }),
        },
        {
          name: "b",
          description: "b",
          create: () => ({ model: new Model("b", childProvider("b", releaseB)), prompt: "b" }),
        },
      ],
    });

    const execution = root.execute(user);
    const done = (async () => {
      for await (const _event of execution.events) {
        // 排空事件流
      }
      return execution.result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const childA = runtime.getTree("root")?.executions.find((item) => item.id === childAExecutionId);
    expect(childA?.delegateName).toBe("a");
    expect(runtime.cancelExecution(childAExecutionId, "Stop only A.")).toBe(true);
    releaseA.resolve("late");
    releaseB.resolve("B done");

    await expect(done).resolves.toMatchObject({ status: "completed" });
    const tree = runtime.getTree("root");
    expect(tree?.executions.find((item) => item.delegateName === "a")?.status).toBe("cancelled");
    expect(tree?.executions.find((item) => item.delegateName === "b")?.status).toBe("completed");
  });

  test("async factory failure creates an accepted failed child exactly once", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    let factoryCalls = 0;
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "broken", task: "work" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: false,
          code: "DELEGATE_FACTORY_FAILED",
        });
        return [finalTextMessage("recovered")];
      },
    ]);
    const root = new Agent({
      model: new Model("root", provider.provider),
      prompt: "root",
      runtime,
      delegates: [
        {
          name: "broken",
          description: "broken",
          create: async () => {
            factoryCalls++;
            throw new Error("nope");
          },
        },
      ],
    });

    const result = await drainExecution(root);
    expect(result.status).toBe("completed");
    expect(factoryCalls).toBe(1);
    expect(runtime.getTree("root")?.executions.find((execution) => execution.id === "child")?.status).toBe("failed");
  });

  test("child model failure is structured and parent continues", async () => {
    const ids = ["root", "child"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const childProvider = createScriptedProvider([
      () => {
        throw new Error("child provider failed with sk-secret");
      },
    ]);
    const parentProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "child", task: "fail" } }])],
      (_index, params) => {
        const content = params.messages.at(-1)?.content[0];
        expect(content?.type === "tool_result" ? JSON.parse(content.content) : null).toMatchObject({
          ok: false,
          code: "MODEL_FAILED",
        });
        return [finalTextMessage("parent recovered")];
      },
    ]);
    const root = new Agent({
      model: new Model("root", parentProvider.provider),
      prompt: "root",
      runtime,
      delegates: [
        {
          name: "child",
          description: "child",
          create: () => ({ model: new Model("child", childProvider.provider), prompt: "child" }),
        },
      ],
    });

    await expect(drainExecution(root)).resolves.toMatchObject({ output: { text: "parent recovered" } });
  });

  test("runtime observer receives lifecycle metadata without message content and survives observer errors", async () => {
    const ids = ["root"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const events: unknown[] = [];
    runtime.subscribe((event) => {
      events.push(event);
      throw new Error("observer failed");
    });
    const provider = createScriptedProvider([() => [finalTextMessage("secret text")]]);
    const root = new Agent({ model: new Model("root", provider.provider), prompt: "root", runtime });

    await expect(drainExecution(root)).resolves.toMatchObject({ status: "completed" });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("secret text");
  });

  test("child count and tree count limits reject before creating extra children", async () => {
    const runtime = new AgentRuntime({
      idFactory: (() => {
        const ids = ["root", "child-a"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => 100,
      limits: { maxChildrenPerExecution: 1, maxExecutionsPerTree: 2 },
    });
    const parentProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "a", name: "delegate_task", input: { agent: "a", task: "A" } },
          { id: "b", name: "delegate_task", input: { agent: "b", task: "B" } },
        ]),
      ],
      (_index, params) => {
        const results = params.messages
          .filter((message) => message.role === "tool")
          .map((message) => JSON.parse(message.content[0]!.content));
        expect(results).toContainEqual(expect.objectContaining({ ok: true }));
        expect(results).toContainEqual(expect.objectContaining({ ok: false, code: "CHILD_LIMIT_EXCEEDED" }));
        return [finalTextMessage("done")];
      },
    ]);
    const childProvider = createScriptedProvider([() => [finalTextMessage("child")]]);
    const root = new Agent({
      model: new Model("root", parentProvider.provider),
      prompt: "root",
      runtime,
      delegates: [
        { name: "a", description: "a", create: () => ({ model: new Model("a", childProvider.provider), prompt: "a" }) },
        { name: "b", description: "b", create: () => ({ model: new Model("b", childProvider.provider), prompt: "b" }) },
      ],
    });

    await expect(drainExecution(root)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getTree("root")?.executions.map((execution) => execution.id)).toEqual(["root", "child-a"]);
  });
});
