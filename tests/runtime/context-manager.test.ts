import { describe, expect, test } from "bun:test";

import { Model, type NonSystemMessage, type Tool } from "@/core";
import {
  Agent,
  AgentRuntime,
  createPhaseTransitionTool,
  RuntimeContextManager,
  type ContextManagerPrepareResult,
  type ContextSummaryRequest,
} from "@/runtime";

import { createScriptedProvider, finalTextMessage } from "./fake-provider";

class FixedSummarizer {
  readonly requests: ContextSummaryRequest[] = [];

  async summarize(request: ContextSummaryRequest) {
    this.requests.push(request);
    return {
      summary: {
        objectives: ["Keep the earlier work available."],
        constraints: ["Do not lose tool relationships."],
        decisions: [],
        progress: ["Older transcript was compacted."],
        results: [],
        artifacts: [],
        pending: [],
      },
      renderedText: `Context Summary: ${request.level}\nProgress:\n- Older transcript was compacted.`,
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18, usageIncomplete: false },
    };
  }
}

class ExpensiveSummarizer extends FixedSummarizer {
  override async summarize(request: ContextSummaryRequest) {
    const result = await super.summarize(request);
    return {
      ...result,
      usage: { promptTokens: 600, completionTokens: 600, totalTokens: 1200, usageIncomplete: false },
    };
  }
}

describe("RuntimeContextManager", () => {
  test("builds a bounded model context without mutating the canonical transcript", async () => {
    const summarizer = new FixedSummarizer();
    const { provider, calls } = createScriptedProvider([() => [finalTextMessage("done", 10)]]);
    const ids = ["turn-1", "turn-2", "turn-3", "segment-1", "phase-1"];
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 420, maxOutputTokens: 64 });
    const messages = longTranscript();
    const agent = new Agent({
      model,
      prompt: "You are a coding agent.",
      messages,
      contextManager: new RuntimeContextManager({
        summarizer,
        policy: {
          recentTurns: 1,
          activeTurnRecentBlocks: 2,
          triggerRatio: 0.1,
          targetRatio: 0.8,
          safetyMarginTokens: 32,
        },
        idFactory: () => ids.shift()!,
        now: () => "2026-08-28T00:00:00.000Z",
      }),
    });

    const events = [];
    const execution = agent.execute({ role: "user", content: [{ type: "text", text: "finish" }] });
    for await (const event of execution.events) {
      events.push(event);
    }
    const result = await execution.result;

    expect(result.status).toBe("completed");
    expect(result.usage.totalTokens).toBeGreaterThan(28);
    expect(calls).toHaveLength(1);
    expect(
      calls[0]!.messages.some((message) => JSON.stringify(message).includes("Older transcript was compacted")),
    ).toBe(true);
    expect(JSON.stringify(calls[0]!.messages)).not.toContain("older detail 0");
    expect(JSON.stringify(agent.messages)).toContain("older detail 0");
    expect(events.some((event) => event.type === "context" && event.status === "completed")).toBe(true);
    expect(summarizer.requests.map((request) => request.level)).toContain("segment");
  });

  test("keeps assistant tool uses with their tool results in the raw window", async () => {
    const summarizer = new FixedSummarizer();
    const { provider, calls } = createScriptedProvider([() => [finalTextMessage("done", 10)]]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 520, maxOutputTokens: 64 });
    const toolUse = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "README.md" } }],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    } satisfies NonSystemMessage;
    const toolResult = {
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "call-1", content: "file content" }],
    } satisfies NonSystemMessage;
    const agent = new Agent({
      model,
      prompt: "Prompt",
      messages: [
        { role: "user", content: [{ type: "text", text: "older " + "x".repeat(1200) }] },
        { role: "assistant", content: [{ type: "text", text: "older answer" }] },
        { role: "user", content: [{ type: "text", text: "use the tool" }] },
        toolUse,
        toolResult,
      ],
      tools: [tool("read_file")],
      contextManager: new RuntimeContextManager({
        summarizer,
        policy: { recentTurns: 1, activeTurnRecentBlocks: 3, triggerRatio: 0.1, safetyMarginTokens: 32 },
      }),
    });

    const execution = agent.execute({ role: "user", content: [{ type: "text", text: "continue" }] });
    for await (const _event of execution.events) {
      // drain
    }
    await execution.result;

    const sent = calls[0]!.messages;
    const assistantIndex = sent.findIndex((message) => message.role === "assistant");
    const toolIndex = sent.findIndex((message) => message.role === "tool");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBe(assistantIndex + 1);
  });

  test("registers one pending phase transition per turn", async () => {
    const manager = new RuntimeContextManager();
    const phaseTool = createPhaseTransitionTool(manager);

    await expect(phaseTool.execute({ objective: "implement persistence" })).resolves.toEqual({
      ok: true,
      summary: "Next phase registered: implement persistence",
    });
    await expect(phaseTool.execute({ objective: "another phase" })).resolves.toMatchObject({
      ok: false,
      code: "PHASE_TRANSITION_CONFLICT",
    });
    expect(manager.consumePendingPhaseTransition()).toEqual({ objective: "implement persistence" });
    expect(manager.consumePendingPhaseTransition()).toBeNull();
  });

  test("reuses existing nodes for the same source range", async () => {
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "older " + "x".repeat(300) }] },
      { role: "assistant", content: [{ type: "text", text: "older answer " + "y".repeat(220) }] },
      { role: "user", content: [{ type: "text", text: "recent detail" }] },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    const manager = new RuntimeContextManager({
      summarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 2,
        triggerRatio: 0.01,
        targetRatio: 0.9,
        safetyMarginTokens: 32,
      },
      idFactory: () => "node-1",
      now: () => "2026-08-28T00:00:00.000Z",
    });

    const first = await manager.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });
    const second = await manager.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });

    expect(first.nodes.map((node) => node.id)).toEqual(["node-1"]);
    expect(second.nodes).toEqual([]);
    expect(second.usage.totalTokens).toBe(0);
    expect(summarizer.requests).toHaveLength(1);
  });

  test("builds segment and phase nodes from lower-level summaries", async () => {
    const ids = ["turn-1", "turn-2", "turn-3", "turn-4", "segment-1", "segment-2", "phase-1"];
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 10000, maxOutputTokens: 64 });
    const manager = new RuntimeContextManager({
      summarizer,
      policy: {
        recentTurns: 0,
        activeTurnRecentBlocks: 0,
        triggerRatio: 0.01,
        targetRatio: 0.95,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 120,
      },
      idFactory: () => ids.shift()!,
      now: () => "2026-08-28T00:00:00.000Z",
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages: longTranscript(),
      model,
      signal: new AbortController().signal,
    });

    expect(result.nodes.map((node) => node.level)).toEqual(["turn", "turn", "turn", "segment", "phase"]);
    expect(result.nodes.at(-1)?.childNodeIds.length).toBeGreaterThan(0);
    expect(result.frontierNodeIds).toEqual([result.nodes.at(-1)!.id]);
  });

  test("records persisted source ids and phase ids when a source snapshot is provided", async () => {
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "older " + "x".repeat(300) }] },
      { role: "assistant", content: [{ type: "text", text: "older answer " + "y".repeat(220) }] },
      { role: "user", content: [{ type: "text", text: "recent detail" }] },
    ];
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "node-1",
      now: () => "2026-08-28T00:00:00.000Z",
      sources: [
        { messageId: "m-1", turnId: "t-1", turnIndex: 0, phaseId: "phase-a", sourceRevision: 12 },
        { messageId: "m-2", turnId: "t-1", turnIndex: 0, phaseId: "phase-a", sourceRevision: 12 },
        { messageId: "m-3", turnId: "t-2", turnIndex: 1, phaseId: "phase-a", sourceRevision: 12 },
      ],
    });

    const result = await manager.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });

    expect(result.nodes[0]).toMatchObject({
      id: "node-1",
      phaseId: "phase-a",
      source: {
        firstMessageId: "m-1",
        lastMessageId: "m-2",
        firstTurnId: "t-1",
        lastTurnId: "t-1",
        sourceRevision: 12,
      },
    });
  });

  test("keeps active Phase checkpoints outside completed Session summaries", async () => {
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 20000, maxOutputTokens: 64 });
    const messages = phaseTranscript(10);
    const manager = new RuntimeContextManager({
      summarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 100,
      },
      idFactory: sequentialIds(),
      now: () => "2026-08-28T00:00:00.000Z",
      sourceRevision: 20,
      sources: phaseSources(10, 20),
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    const completedPhases = result.nodes.filter((node) => node.level === "phase" && !node.checkpoint);
    const activeCheckpoint = result.nodes.find((node) => node.level === "phase" && node.checkpoint);
    const sessionNode = result.nodes.find((node) => node.level === "session");
    expect(completedPhases).toHaveLength(2);
    expect(activeCheckpoint).toMatchObject({ phaseId: "phase-c", checkpoint: true });
    expect(sessionNode?.childNodeIds).toEqual(completedPhases.map((node) => node.id));
    expect(sessionNode?.childNodeIds).not.toContain(activeCheckpoint?.id);
    expect(result.frontierNodeIds).toEqual([sessionNode!.id, activeCheckpoint!.id]);
  });

  test("preserves the current User Message while checkpointing earlier current-turn blocks", async () => {
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 1000, maxOutputTokens: 64 });
    const currentUser = {
      role: "user",
      content: [{ type: "text", text: "Keep this request exactly as written: implement the bounded context view." }],
    } satisfies NonSystemMessage;
    const messages: NonSystemMessage[] = [
      currentUser,
      toolUseMessage("call-old", "read_file"),
      toolResultMessage("call-old", "x".repeat(2400)),
      toolUseMessage("call-recent", "read_file"),
      toolResultMessage("call-recent", "recent result"),
    ];
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { activeTurnRecentBlocks: 1, triggerRatio: 0.1, targetRatio: 0.8, safetyMarginTokens: 32 },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.messages[0]).toEqual(currentUser);
    expect(summarizer.requests[0]?.sourceText).not.toContain("Keep this request exactly as written");
    expect(JSON.stringify(result.messages[1])).toContain("Older transcript was compacted");
    expect(result.messages.slice(-2)).toEqual(messages.slice(-2));
  });

  test("reduces oversized Tool Results only in the model context", async () => {
    const summarizer = new FixedSummarizer();
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 700, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "Inspect the tool output." }] },
      toolUseMessage("call-large", "read_file"),
      toolResultMessage("call-large", `head-${"x".repeat(5000)}-tail`),
    ];
    const canonical = structuredClone(messages);
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { activeTurnRecentBlocks: 2, triggerRatio: 0.1, safetyMarginTokens: 32 },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages[1]).toEqual(messages[1]);
    expect(JSON.stringify(result.messages[2])).toContain("characters omitted from this model context");
    expect(JSON.stringify(result.messages[2]).length).toBeLessThan(JSON.stringify(messages[2]).length);
    expect(messages).toEqual(canonical);
  });

  test("keeps structured Tool Result summaries and errors during context-only reduction", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 700, maxOutputTokens: 64 });
    const content = JSON.stringify({
      ok: false,
      summary: "File inspection failed",
      error: "The requested file could not be parsed",
      code: "PARSE_FAILED",
      details: "x".repeat(5000),
    });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "Inspect the failure." }] },
      toolUseMessage("call-error", "read_file"),
      toolResultMessage("call-error", content),
    ];
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { activeTurnRecentBlocks: 2, triggerRatio: 0.1, safetyMarginTokens: 32 },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });
    const toolMessage = result.messages.find((message) => message.role === "tool");
    const reduced = JSON.parse(toolMessage?.role === "tool" ? toolMessage.content[0]!.content : "{}");

    expect(reduced).toMatchObject({
      contextReduced: true,
      summary: "File inspection failed",
      error: "The requested file could not be parsed",
      code: "PARSE_FAILED",
    });
    expect(result.messages[1]).toEqual(messages[1]);
    expect(messages[2]).toEqual(toolResultMessage("call-error", content));
  });

  test("rejects a current User Message that cannot fit without truncation", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 400, maxOutputTokens: 64 });
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { triggerRatio: 0.1, safetyMarginTokens: 32 },
    });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `unalterable ${"x".repeat(5000)}` }] },
    ];

    await expect(
      manager.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: "CONTEXT_BLOCK_TOO_LARGE" });
    expect(messages[0]?.content[0]).toMatchObject({ type: "text", text: `unalterable ${"x".repeat(5000)}` });
  });

  test("restores an active Phase checkpoint and replaces it with a Final Phase node when completed", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 10000, maxOutputTokens: 64 });
    const messages = phaseTranscript(4);
    const activeSources = singlePhaseSources(4, 20, "active");
    const active = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      idFactory: sequentialIds(),
      sourceRevision: 20,
      sources: activeSources,
    });
    const activeResult = await active.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });
    const checkpoint = activeResult.nodes.find((node) => node.level === "phase" && node.checkpoint)!;
    expect(activeResult.frontierNodeIds).toEqual([checkpoint.id]);

    const resumedSummarizer = new FixedSummarizer();
    const resumed = new RuntimeContextManager({
      summarizer: resumedSummarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      initialNodes: active.snapshotNodes(),
      initialFrontierNodeIds: activeResult.frontierNodeIds,
      sourceRevision: 21,
      sources: singlePhaseSources(4, 21, "active"),
    });
    const resumedResult = await resumed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });
    expect(resumedResult.nodes).toEqual([]);
    expect(resumedResult.frontierNodeIds).toEqual([checkpoint.id]);
    expect(resumedSummarizer.requests).toHaveLength(0);

    const completed = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      idFactory: () => "final-phase",
      initialNodes: active.snapshotNodes(),
      initialFrontierNodeIds: activeResult.frontierNodeIds,
      sourceRevision: 22,
      sources: singlePhaseSources(4, 22, "completed"),
    });
    const completedResult = await completed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(completedResult.nodes).toHaveLength(1);
    expect(completedResult.nodes[0]).toMatchObject({ id: "final-phase", level: "phase", checkpoint: false });
    expect(completedResult.frontierNodeIds).toEqual(["final-phase"]);
  });

  test("reuses persisted source ids after the Session revision advances", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `older ${"x".repeat(400)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ];
    const firstSources = stableSources(12);
    const first = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "node-1",
      sourceRevision: 12,
      sources: firstSources,
    });
    const firstResult = await first.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });
    const secondSummarizer = new FixedSummarizer();
    const second = new RuntimeContextManager({
      summarizer: secondSummarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => {
        throw new Error("A compatible node should have been reused.");
      },
      initialNodes: first.snapshotNodes(),
      initialFrontierNodeIds: firstResult.frontierNodeIds,
      sourceRevision: 13,
      sources: stableSources(13),
    });

    const secondResult = await second.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(secondResult.nodes).toEqual([]);
    expect(secondResult.frontierNodeIds).toEqual(firstResult.frontierNodeIds);
    expect(secondSummarizer.requests).toHaveLength(0);
  });

  test("does not reuse nodes from a different summary schema", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `older ${"x".repeat(400)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ];
    const seed = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "old-node",
      sourceRevision: 12,
      sources: stableSources(12),
    });
    await seed.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });
    const incompatible = seed.snapshotNodes().map((node) => ({ ...node, summarySchemaVersion: 99 }));
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "new-node",
      initialNodes: incompatible,
      sourceRevision: 13,
      sources: stableSources(13),
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.nodes.map((node) => node.id)).toEqual(["new-node"]);
    expect(summarizer.requests).toHaveLength(1);
  });

  test("does not reuse nodes from a different Context policy", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `older ${"x".repeat(400)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ];
    const seed = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        policyVersion: "context-v1",
      },
      idFactory: () => "old-node",
      sourceRevision: 12,
      sources: stableSources(12),
    });
    await seed.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        safetyMarginTokens: 32,
        policyVersion: "context-v2",
      },
      idFactory: () => "new-node",
      initialNodes: seed.snapshotNodes(),
      sourceRevision: 13,
      sources: stableSources(13),
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.nodes.map((node) => node.id)).toEqual(["new-node"]);
    expect(result.policyVersion).toBe("context-v2");
    expect(summarizer.requests).toHaveLength(1);
  });

  test("commits a changed frontier even when every node is reused", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `older ${"x".repeat(400)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ];
    const seed = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "node-1",
      sourceRevision: 12,
      sources: stableSources(12),
    });
    await seed.prepare({ prompt: "Prompt", messages, model, signal: new AbortController().signal });
    const commits: ContextManagerPrepareResult[] = [];
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      initialNodes: seed.snapshotNodes(),
      initialFrontierNodeIds: [],
      sourceRevision: 13,
      sources: stableSources(13),
      onCompaction: (result) => {
        commits.push(result);
      },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.nodes).toEqual([]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.frontierNodeIds).toEqual(["node-1"]);
  });

  test("stops before the main model call when summary usage exceeds the execution tree budget", async () => {
    const { provider, calls } = createScriptedProvider([() => [finalTextMessage("should not run", 10)]]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 420, maxOutputTokens: 64 });
    const agent = new Agent({
      model,
      prompt: "You are a coding agent.",
      messages: longTranscript(),
      runtime: new AgentRuntime({ limits: { maxTokensPerTree: 1000 } }),
      contextManager: new RuntimeContextManager({
        summarizer: new ExpensiveSummarizer(),
        policy: { recentTurns: 1, activeTurnRecentBlocks: 2, triggerRatio: 0.1, safetyMarginTokens: 32 },
      }),
    });

    const execution = agent.execute({ role: "user", content: [{ type: "text", text: "finish" }] });
    for await (const _event of execution.events) {
      // drain
    }
    const result = await execution.result;

    expect(result.status).toBe("limit_exceeded");
    expect(result.error?.code).toBe("TOKEN_LIMIT_EXCEEDED");
    expect(calls).toHaveLength(0);
  });
});

function longTranscript(): NonSystemMessage[] {
  const messages: NonSystemMessage[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `older detail ${i} ${"x".repeat(600)}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `older answer ${i} ${"y".repeat(400)}` }] });
  }
  return messages;
}

function phaseTranscript(turns: number): NonSystemMessage[] {
  const messages: NonSystemMessage[] = [];
  for (let index = 0; index < turns; index++) {
    messages.push({ role: "user", content: [{ type: "text", text: `request ${index} ${"x".repeat(300)}` }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: `response ${index} ${"y".repeat(220)}` }] });
  }
  return messages;
}

function phaseSources(turns: number, sourceRevision: number) {
  return Array.from({ length: turns * 2 }, (_, messageIndex) => {
    const turnIndex = Math.floor(messageIndex / 2);
    const phase = turnIndex < 2 ? "phase-a" : turnIndex < 4 ? "phase-b" : "phase-c";
    return {
      messageId: `message-${messageIndex}`,
      turnId: `turn-${turnIndex}`,
      turnIndex,
      phaseId: phase,
      phaseStatus: phase === "phase-c" ? ("active" as const) : ("completed" as const),
      sourceRevision,
    };
  });
}

function stableSources(sourceRevision: number) {
  return [
    { messageId: "message-1", turnId: "turn-1", turnIndex: 0, sourceRevision },
    { messageId: "message-2", turnId: "turn-1", turnIndex: 0, sourceRevision },
    { messageId: "message-3", turnId: "turn-2", turnIndex: 1, sourceRevision },
  ];
}

function singlePhaseSources(turns: number, sourceRevision: number, phaseStatus: "active" | "completed") {
  return Array.from({ length: turns * 2 }, (_, messageIndex) => {
    const turnIndex = Math.floor(messageIndex / 2);
    return {
      messageId: `single-message-${messageIndex}`,
      turnId: `single-turn-${turnIndex}`,
      turnIndex,
      phaseId: "single-phase",
      phaseStatus,
      sourceRevision,
    };
  });
}

function sequentialIds() {
  let value = 0;
  return () => `node-${++value}`;
}

function toolUseMessage(id: string, name: string): NonSystemMessage {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input: { path: "README.md" } }] };
}

function toolResultMessage(id: string, content: string): NonSystemMessage {
  return { role: "tool", content: [{ type: "tool_result", tool_use_id: id, content }] };
}

function tool(name: string): Tool {
  return {
    name,
    description: "Reads a file.",
    effect: { kind: "read", scope: "process", description: "Test tool." },
    parameters: { safeParse: (value: unknown) => ({ success: true, data: value }) } as Tool["parameters"],
    execute: async () => "ok",
  };
}
