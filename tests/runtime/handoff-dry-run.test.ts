import { describe, expect, test } from "bun:test";
import z from "zod";

import { defineTool, Model, type Message } from "@/core";
import { Agent, AgentRuntime, type ExecutionEvent, type HandoffDefinition } from "@/runtime";

import { createScriptedProvider, finalTextMessage, finalToolUseMessage } from "./fake-provider";

const user = { role: "user" as const, content: [{ type: "text" as const, text: "go" }] };

function parseToolResult(message: Message | undefined) {
  const content = message?.content[0];
  expect(content?.type).toBe("tool_result");
  return content?.type === "tool_result" ? JSON.parse(content.content) : null;
}

async function drainRun(agent: Agent, options: Parameters<Agent["execute"]>[1] = {}) {
  const run = agent.execute(user, options);
  for await (const _event of run.events) {
    // drain
  }
  return run.result;
}

describe("dry-run tool execution", () => {
  test("previews mutation tools and executes read tools without changing persistent state", async () => {
    let readExecuted = false;
    let mutationExecuted = false;
    let mutationPreviewed = false;

    const readTool = defineTool({
      name: "read_state",
      description: "Reads current state.",
      parameters: z.object({}),
      effect: { kind: "read", scope: "workspace", description: "Read test state." },
      execute: async () => {
        readExecuted = true;
        return "current state";
      },
    });
    const writeTool = defineTool({
      name: "write_state",
      description: "Writes state.",
      parameters: z.object({ value: z.string() }),
      effect: { kind: "mutation", scope: "workspace", description: "Write test state." },
      execute: async () => {
        mutationExecuted = true;
        return "written";
      },
      preview: async ({ value }) => {
        mutationPreviewed = true;
        return {
          status: "planned",
          summary: `Would write ${value}.`,
          operations: [
            {
              action: "write",
              resource: { kind: "state", identifier: "memory" },
              description: `Set state to ${value}.`,
              after: value,
            },
          ],
          warnings: [],
          confidence: "exact",
        };
      },
    });

    const provider = createScriptedProvider([
      () => [
        finalToolUseMessage([
          { id: "read", name: "read_state", input: {} },
          { id: "write", name: "write_state", input: { value: "next" } },
        ]),
      ],
      (_index, params) => {
        const results = params.messages
          .filter((message) => message.role === "tool")
          .map((message) => parseToolResult(message));
        expect(results).toContainEqual(expect.objectContaining({ mode: "dry_run", disposition: "executed" }));
        expect(results).toContainEqual(expect.objectContaining({ mode: "dry_run", disposition: "previewed" }));
        return [finalTextMessage("done")];
      },
    ]);
    const agent = new Agent({
      model: new Model("root", provider.provider),
      prompt: "root",
      tools: [readTool, writeTool],
    });

    const result = await drainRun(agent, { mode: "dry_run" });

    expect(result.status).toBe("completed");
    expect(readExecuted).toBe(true);
    expect(mutationPreviewed).toBe(true);
    expect(mutationExecuted).toBe(false);
    expect(result.dryRunReport?.summary).toMatchObject({ executedReads: 1, previews: 1, blocked: 0 });
  });

  test("blocks mutation tools without previews in dry-run mode", async () => {
    let mutationExecuted = false;
    const unsafeTool = defineTool({
      name: "unsafe_write",
      description: "Writes without preview.",
      parameters: z.object({}),
      effect: { kind: "mutation", scope: "workspace", description: "Unsafe write." },
      execute: async () => {
        mutationExecuted = true;
        return "written";
      },
    });
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "unsafe", name: "unsafe_write", input: {} }])],
      (_index, params) => {
        const result = parseToolResult(params.messages.at(-1));
        expect(result).toMatchObject({
          ok: false,
          mode: "dry_run",
          disposition: "blocked",
          code: "DRY_RUN_PREVIEW_UNAVAILABLE",
        });
        return [finalTextMessage("recovered")];
      },
    ]);
    const agent = new Agent({ model: new Model("root", provider.provider), prompt: "root", tools: [unsafeTool] });

    const result = await drainRun(agent, { mode: "dry_run" });

    expect(result.status).toBe("completed");
    expect(mutationExecuted).toBe(false);
    expect(result.dryRunReport?.status).toBe("partial");
    expect(result.dryRunReport?.summary.blocked).toBe(1);
  });

  test("skips middleware hooks that opt out of dry-run", async () => {
    let middlewareCalls = 0;
    const readTool = defineTool({
      name: "read_state",
      description: "Reads current state.",
      parameters: z.object({}),
      effect: { kind: "read", scope: "workspace", description: "Read test state." },
      execute: async () => "current state",
    });
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "read", name: "read_state", input: {} }])],
      () => [finalTextMessage("done")],
    ]);
    const agent = new Agent({
      model: new Model("root", provider.provider),
      prompt: "root",
      tools: [readTool],
      middlewares: [
        {
          dryRun: { mode: "skip" },
          beforeModel: async () => {
            middlewareCalls++;
          },
          beforeToolUse: async () => {
            middlewareCalls++;
          },
          afterToolUse: async () => {
            middlewareCalls++;
          },
        },
      ],
    });

    const result = await drainRun(agent, { mode: "dry_run" });

    expect(result.status).toBe("completed");
    expect(middlewareCalls).toBe(0);
  });

  test("rejects dry-run when middleware declares itself forbidden", async () => {
    const provider = createScriptedProvider([
      () => {
        throw new Error("model should not be called");
      },
    ]);
    const agent = new Agent({
      model: new Model("root", provider.provider),
      prompt: "root",
      middlewares: [{ name: "unsafe-middleware", dryRun: { mode: "forbidden", reason: "writes external state" } }],
    });

    const result = await drainRun(agent, { mode: "dry_run" });

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "MIDDLEWARE_FAILED", message: expect.stringContaining("unsafe-middleware") },
    });
  });

  test("aggregates delegated previews into the root tree report", async () => {
    const ids = ["root-exec", "child-exec"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()! });
    const childMutation = defineTool({
      name: "child_write",
      description: "Preview a child mutation.",
      parameters: z.object({}),
      effect: { kind: "mutation", scope: "workspace", description: "Mutate child state." },
      execute: async () => "written",
      preview: async () => ({
        status: "planned",
        summary: "Would update child state.",
        operations: [],
        warnings: [],
        confidence: "exact",
      }),
    });
    const childProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "child-write", name: "child_write", input: {} }])],
      () => [finalTextMessage("child done")],
    ]);
    const rootProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([{ id: "delegate", name: "delegate_task", input: { agent: "worker", task: "plan" } }]),
      ],
      () => [finalTextMessage("root done")],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root",
      runtime,
      delegates: [
        {
          name: "worker",
          description: "worker",
          create: () => ({
            id: "worker",
            model: new Model("worker", childProvider.provider),
            prompt: "worker",
            tools: [childMutation],
          }),
          policy: { tools: { mode: "explicit", tools: [childMutation] } },
        },
      ],
    });

    const result = await drainRun(root, { mode: "dry_run" });

    expect(result.dryRunReport?.entries.map((entry) => [entry.branchId, entry.toolName])).toEqual([
      ["child-exec", "child_write"],
      ["root-exec", "delegate_task"],
    ]);
    expect(result.dryRunReport?.summary).toMatchObject({ previews: 1, controlOperations: 1 });
  });

  test("rejects non-serializable previews before they enter the report", async () => {
    const invalidPreviewTool = defineTool({
      name: "invalid_preview",
      description: "Returns an invalid preview.",
      parameters: z.object({}),
      effect: { kind: "mutation", scope: "workspace", description: "Test invalid preview." },
      execute: async () => "written",
      preview: async () =>
        ({
          status: "planned",
          summary: "invalid",
          operations: [],
          warnings: [],
          confidence: "exact",
          details: { callback: () => undefined },
        }) as never,
    });
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "invalid", name: "invalid_preview", input: {} }])],
      (_index, params) => {
        expect(parseToolResult(params.messages.at(-1))).toMatchObject({ code: "DRY_RUN_PREVIEW_INVALID" });
        return [finalTextMessage("done")];
      },
    ]);
    const agent = new Agent({
      model: new Model("root", provider.provider),
      prompt: "root",
      tools: [invalidPreviewTool],
    });

    const result = await drainRun(agent, { mode: "dry_run" });

    expect(result.dryRunReport?.summary.blocked).toBe(1);
  });

  test("strict registration rejects mutation tools without previews", () => {
    const runtime = new AgentRuntime({ strictToolRegistration: true });
    const unsafeTool = defineTool({
      name: "unsafe_write",
      description: "Writes without preview.",
      parameters: z.object({}),
      effect: { kind: "mutation", scope: "workspace", description: "Unsafe write." },
      execute: async () => "written",
    });
    expect(
      () =>
        new Agent({
          model: new Model("root", createScriptedProvider([]).provider),
          prompt: "root",
          tools: [unsafeTool],
          runtime,
        }),
    ).toThrow("requires a preview");
  });
});

describe("handoff execution branches", () => {
  test("commits a successor execution in the same branch and lets it finish the run", async () => {
    const ids = ["root-exec", "reviewer-exec"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const reviewerProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
        const handoffResult = parseToolResult(params.messages.at(-1));
        expect(handoffResult).toMatchObject({
          ok: true,
          data: { targetAgentId: "reviewer", successorExecutionId: "reviewer-exec" },
        });
        return [finalTextMessage("review complete")];
      },
    ]);
    const handoff: HandoffDefinition = {
      target: "reviewer",
      description: "Transfer to reviewer.",
      input: z.object({ task: z.string() }),
      create: ({ input }) => {
        expect(input.task).toBe("review this");
        return {
          id: "reviewer",
          name: "reviewer",
          model: new Model("reviewer", reviewerProvider.provider),
          prompt: "reviewer prompt",
        };
      },
    };
    const rootProvider = createScriptedProvider([
      (_index, params) => {
        expect(params.tools?.map((tool) => tool.name)).toContain("handoff_to_reviewer");
        return [
          finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: { task: "review this" } }]),
        ];
      },
    ]);
    const root = new Agent({
      id: "root",
      name: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root prompt",
      runtime,
      handoffs: [handoff],
    });

    const result = await drainRun(root);
    const tree = runtime.getTree("root-exec");

    expect(result).toMatchObject({
      branchId: "root-exec",
      initialExecutionId: "root-exec",
      finalExecutionId: "reviewer-exec",
      initialAgentId: "root",
      finalAgentId: "reviewer",
      status: "completed",
      handoffs: [{ sourceExecutionId: "root-exec", successorExecutionId: "reviewer-exec" }],
    });
    expect(tree?.branches[0]?.executionIds).toEqual(["root-exec", "reviewer-exec"]);
    expect(
      tree?.executions.map((execution) => [execution.id, execution.status, execution.successorExecutionId]),
    ).toEqual([
      ["root-exec", "handed_off", "reviewer-exec"],
      ["reviewer-exec", "completed", undefined],
    ]);
  });

  test("runs handoff middleware before commit and after commit", async () => {
    const ids = ["root-exec", "reviewer-exec"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    let afterHandoffCalled = false;
    const reviewerProvider = createScriptedProvider([
      (_index, params) => {
        const toolResult = parseToolResult(params.messages.at(-1));
        expect(toolResult).toMatchObject({ ok: true });
        return [finalTextMessage("review complete")];
      },
    ]);
    const handoff: HandoffDefinition = {
      target: "reviewer",
      description: "Transfer to reviewer.",
      input: z.object({ task: z.string() }),
      create: ({ input }) => {
        expect(input.task).toBe("narrowed");
        return {
          id: "reviewer",
          model: new Model("reviewer", reviewerProvider.provider),
          prompt: "reviewer prompt",
        };
      },
    };
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: { task: "wide" } }])],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root prompt",
      runtime,
      handoffs: [handoff],
      middlewares: [
        {
          beforeHandoff: async ({ input }) => {
            expect(input.task).toBe("wide");
            return { action: "continue", input: { task: "narrowed" } };
          },
          afterHandoff: async ({ record }) => {
            afterHandoffCalled = true;
            expect(record).toMatchObject({ sourceExecutionId: "root-exec", successorExecutionId: "reviewer-exec" });
          },
        },
      ],
    });

    const result = await drainRun(root);

    expect(result.status).toBe("completed");
    expect(afterHandoffCalled).toBe(true);
  });

  test("publishes the committed handoff and continues when an after hook fails", async () => {
    const ids = ["root-exec", "reviewer-exec"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const reviewerProvider = createScriptedProvider([() => [finalTextMessage("review complete")]]);
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: {} }])],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root prompt",
      runtime,
      handoffs: [
        {
          target: "reviewer",
          description: "Transfer to reviewer.",
          input: z.object({}),
          create: () => ({
            id: "reviewer",
            model: new Model("reviewer", reviewerProvider.provider),
            prompt: "reviewer prompt",
          }),
        },
      ],
      middlewares: [
        {
          afterHandoff: async () => {
            throw new Error("observer failed");
          },
        },
      ],
    });

    const run = root.execute(user);
    const events: ExecutionEvent[] = [];
    for await (const event of run.events) events.push(event);
    const result = await run.result;

    expect(result).toMatchObject({ status: "completed", finalAgentId: "reviewer" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "handoff",
        status: "committed",
        sourceExecutionId: "root-exec",
        successorExecutionId: "reviewer-exec",
        record: expect.objectContaining({ targetAgentId: "reviewer" }),
      }),
    );
  });

  test("handoff middleware can reject before successor creation", async () => {
    let successorCreated = false;
    const provider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: { task: "review" } }])],
      (_index, params) => {
        const result = parseToolResult(params.messages.at(-1));
        expect(result).toMatchObject({ ok: false, code: "HANDOFF_NOT_ALLOWED" });
        return [finalTextMessage("stayed with root")];
      },
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", provider.provider),
      prompt: "root prompt",
      handoffs: [
        {
          target: "reviewer",
          description: "Transfer to reviewer.",
          input: z.object({ task: z.string() }),
          create: () => {
            successorCreated = true;
            return { id: "reviewer", model: new Model("reviewer", provider.provider), prompt: "reviewer" };
          },
        },
      ],
      middlewares: [
        {
          beforeHandoff: async () => ({
            action: "reject",
            result: { ok: false, summary: "Not allowed.", error: "Not allowed.", code: "HANDOFF_NOT_ALLOWED" },
          }),
        },
      ],
    });

    const result = await drainRun(root);

    expect(result.status).toBe("completed");
    expect(result.finalAgentId).toBe("root");
    expect(successorCreated).toBe(false);
  });

  test("validates handoff registration at agent construction", () => {
    const model = new Model("root", createScriptedProvider([]).provider);
    const baseHandoff: HandoffDefinition = {
      target: "reviewer",
      description: "Transfer to reviewer.",
      input: z.object({}),
      create: () => ({ id: "reviewer", model, prompt: "reviewer" }),
    };

    expect(
      () =>
        new Agent({
          id: "root",
          model,
          prompt: "root",
          handoffs: [baseHandoff, baseHandoff],
        }),
    ).toThrow("Duplicate handoff target");
    expect(
      () =>
        new Agent({
          id: "root",
          model,
          prompt: "root",
          handoffs: [{ ...baseHandoff, target: "Root Agent" }],
        }),
    ).toThrow("Invalid agent id");
    expect(
      () =>
        new Agent({
          id: "root",
          model,
          prompt: "root",
          handoffs: [{ ...baseHandoff, target: "root" }],
        }),
    ).toThrow("cannot hand off directly to itself");
    expect(
      () =>
        new Agent({
          id: "root",
          model,
          prompt: "root",
          tools: [
            defineTool({
              name: "handoff_to_reviewer",
              description: "conflict",
              parameters: z.object({}),
              effect: { kind: "read", scope: "process", description: "conflict" },
              execute: async () => "ok",
            }),
          ],
          handoffs: [baseHandoff],
        }),
    ).toThrow("conflicts with an existing tool");
  });

  test("handoff does not reset branch step limit", async () => {
    const ids = ["root-exec", "reviewer-exec"];
    const runtime = new AgentRuntime({
      idFactory: () => ids.shift()!,
      limits: { maxStepsPerBranch: 1 },
    });
    const reviewerProvider = createScriptedProvider([
      () => {
        throw new Error("successor should be stopped before another model call");
      },
    ]);
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: {} }])],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root prompt",
      runtime,
      handoffs: [
        {
          target: "reviewer",
          description: "Transfer to reviewer.",
          input: z.object({}),
          create: () => ({
            id: "reviewer",
            model: new Model("reviewer", reviewerProvider.provider),
            prompt: "reviewer prompt",
          }),
        },
      ],
    });

    const result = await drainRun(root);

    expect(result).toMatchObject({
      status: "limit_exceeded",
      finalExecutionId: "reviewer-exec",
      finalAgentId: "reviewer",
      steps: 2,
      error: { code: "MAX_STEPS_EXCEEDED" },
    });
  });

  test("rejects a filtered context that removes the handoff exchange", async () => {
    const reviewerProvider = createScriptedProvider([() => [finalTextMessage("unused")]]);
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: {} }])],
      (_index, params) => {
        expect(parseToolResult(params.messages.at(-1))).toMatchObject({ code: "HANDOFF_CONTEXT_INVALID" });
        return [finalTextMessage("root retained control")];
      },
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root",
      handoffs: [
        {
          target: "reviewer",
          description: "review",
          input: z.object({}),
          create: () => ({
            id: "reviewer",
            model: new Model("reviewer", reviewerProvider.provider),
            prompt: "reviewer",
          }),
          context: { mode: "filter", filter: ({ messages }) => messages.filter((message) => message.role === "user") },
        },
      ],
    });

    const result = await drainRun(root);

    expect(result).toMatchObject({ status: "completed", finalAgentId: "root" });
  });

  test("does not commit a successor when the source is cancelled during target preparation", async () => {
    let resolveFactoryStarted!: () => void;
    let releaseFactory!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      resolveFactoryStarted = resolve;
    });
    const factoryRelease = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    const runtime = new AgentRuntime();
    const reviewerProvider = createScriptedProvider([() => [finalTextMessage("should not run")]]);
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: {} }])],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root",
      runtime,
      handoffs: [
        {
          target: "reviewer",
          description: "review",
          input: z.object({}),
          create: async () => {
            resolveFactoryStarted();
            await factoryRelease;
            return {
              id: "reviewer",
              model: new Model("reviewer", reviewerProvider.provider),
              prompt: "reviewer",
            };
          },
        },
      ],
    });
    const run = root.execute(user);
    const events: ExecutionEvent[] = [];
    const drained = (async () => {
      for await (const event of run.events) events.push(event);
      return run.result;
    })();
    await factoryStarted;
    root.abort();
    releaseFactory();

    const result = await drained;
    expect(result).toMatchObject({ status: "cancelled", finalAgentId: "root" });
    expect(runtime.getTree(result.rootExecutionId)?.executions).toHaveLength(1);
    expect(events.some((event) => event.type === "handoff" && event.status === "committed")).toBe(false);
    expect(reviewerProvider.calls).toHaveLength(0);
  });

  test("aborting the original agent cancels the active handoff successor", async () => {
    let successorSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const waitTool = defineTool({
      name: "wait",
      description: "Wait until cancelled.",
      parameters: z.object({}),
      effect: { kind: "read", scope: "process", description: "Wait for cancellation." },
      execute: async (_input, context) => {
        successorSignal = context.signal;
        resolveStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
      },
    });
    const reviewerProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "wait", name: "wait", input: {} }])],
    ]);
    const rootProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff-1", name: "handoff_to_reviewer", input: {} }])],
    ]);
    const root = new Agent({
      id: "root",
      model: new Model("root", rootProvider.provider),
      prompt: "root",
      handoffs: [
        {
          target: "reviewer",
          description: "review",
          input: z.object({}),
          create: () => ({
            id: "reviewer",
            model: new Model("reviewer", reviewerProvider.provider),
            prompt: "reviewer",
            tools: [waitTool],
          }),
        },
      ],
    });
    const run = root.execute(user);
    const drained = (async () => {
      for await (const _event of run.events) {
        // drain
      }
      return run.result;
    })();
    await started;
    root.abort();

    await expect(drained).resolves.toMatchObject({ status: "cancelled", finalAgentId: "reviewer" });
    expect(successorSignal?.aborted).toBe(true);
  });
});
