import { describe, expect, test } from "bun:test";

import { Model, type NonSystemMessage, type Tool } from "@/core";
import {
  Agent,
  AgentRuntime,
  createPhaseTransitionTool,
  RuntimeContextManager,
  TokenEstimator,
  type CompactionNode,
  type ContextPhaseState,
  type ContextManagerPrepareResult,
  type ContextRestoreState,
  type ContextSourceMessage,
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

class CountingEstimator extends TokenEstimator {
  messageCount = 0;

  override estimateMessage(message: Parameters<TokenEstimator["estimateMessage"]>[0]): number {
    this.messageCount++;
    return super.estimateMessage(message);
  }
}

class PredictableEstimator extends TokenEstimator {
  constructor(private readonly summaryTokens: number) {
    super();
  }

  override estimateMessage(message: Parameters<TokenEstimator["estimateMessage"]>[0]): number {
    const text = JSON.stringify(message);
    if (text.includes("Context Summary:")) return this.summaryTokens;
    if (text.includes("current request")) return 10;
    return 100;
  }
}

describe("RuntimeContextManager", () => {
  test("builds a bounded model context without mutating the canonical transcript", async () => {
    const summarizer = new FixedSummarizer();
    const { provider, calls } = createScriptedProvider([() => [finalTextMessage("done", 10)]]);
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
        idFactory: sequentialIds(),
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
        policy: { recentTurns: 2, activeTurnRecentBlocks: 3, triggerRatio: 0.1, safetyMarginTokens: 32 },
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

    expect(nodesOf(first).map((node) => node.id)).toEqual(["node-1"]);
    expect(second.stateUpdate).toBeUndefined();
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
        targetRatio: 0.005,
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

    const nodes = nodesOf(result);
    expect(nodes.filter((node) => node.level === "turn")).toHaveLength(3);
    expect(nodes.map((node) => node.level)).toContain("segment");
    expect(nodes.map((node) => node.level)).toContain("phase");
    expect(nodes.map((node) => node.level)).toContain("session");
    expect(nodes.filter((node) => node.level !== "turn").every((node) => node.childNodeIds.length > 0)).toBe(true);
    expect(frontierOf(result)).toEqual([nodes.at(-1)!.id]);
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
    });
    const sources = [
      { messageId: "m-1", turnId: "t-1", turnIndex: 0, phaseId: "phase-a", sourceRevision: 12 },
      { messageId: "m-2", turnId: "t-1", turnIndex: 0, phaseId: "phase-a", sourceRevision: 12 },
      { messageId: "m-3", turnId: "t-2", turnIndex: 1, phaseId: "phase-a", sourceRevision: 12 },
    ];

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources,
    });

    expect(nodesOf(result)[0]).toMatchObject({
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
        targetRatio: 0.005,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 100,
      },
      idFactory: sequentialIds(),
      now: () => "2026-08-28T00:00:00.000Z",
    });
    const sources = phaseSources(10, 20);

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources,
    });

    const nodes = nodesOf(result);
    const completedPhases = nodes.filter((node) => node.level === "phase" && !node.checkpoint);
    const activeCheckpoint = nodes.find((node) => node.level === "phase" && node.checkpoint);
    const sessionNode = nodes.find((node) => node.level === "session");
    expect(completedPhases).toHaveLength(2);
    expect(activeCheckpoint).toMatchObject({ phaseId: "phase-c", checkpoint: true });
    expect(sessionNode?.childNodeIds).toEqual(completedPhases.map((node) => node.id));
    expect(sessionNode?.childNodeIds).not.toContain(activeCheckpoint?.id);
    expect(frontierOf(result)).toEqual([sessionNode!.id, activeCheckpoint!.id]);
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
    const activePhases = [
      { id: "single-phase", status: "active" as const, startedTurnId: "single-turn-0" },
    ];
    const active = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        targetRatio: 0.005,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      idFactory: sequentialIds(),
      restoreState: emptyRestoreState(20, activeSources, activePhases),
    });
    const activeResult = await active.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: activeSources,
    });
    const activeNodes = nodesOf(activeResult);
    const checkpoint = activeNodes.find((node) => node.level === "phase" && node.checkpoint)!;
    expect(frontierOf(activeResult)).toEqual([checkpoint.id]);

    const resumedSummarizer = new FixedSummarizer();
    const resumed = new RuntimeContextManager({
      summarizer: resumedSummarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        targetRatio: 0.005,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      restoreState: {
        currentSourceRevision: 21,
        sources: singlePhaseSources(4, 21, "active"),
        phases: activePhases,
        nodes: activeNodes,
        checkpoint: activeResult.stateUpdate!.checkpoint,
      },
    });
    const resumedResult = await resumed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      canonicalAppendOnly: true,
    });
    expect(resumedResult.path).toBe("incremental");
    expect(resumedResult.stateUpdate).toBeUndefined();
    expect(resumedSummarizer.requests).toHaveLength(0);

    const completedSources = [
      ...singlePhaseSources(4, 22, "completed"),
      {
        messageId: "next-message",
        turnId: "next-turn",
        turnIndex: 4,
        phaseId: "next-phase",
        phaseStatus: "active" as const,
        sourceRevision: 22,
      },
    ];
    const completedPhases = [
      {
        id: "single-phase",
        status: "completed" as const,
        startedTurnId: "single-turn-0",
        endedTurnId: "single-turn-3",
      },
      { id: "next-phase", status: "active" as const, startedTurnId: "next-turn" },
    ];
    const completedMessages = [
      ...messages,
      { role: "user", content: [{ type: "text", text: "start the next phase" }] } satisfies NonSystemMessage,
    ];
    const finalIds = ["final-turn", "final-phase", "final-session"];
    const completed = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.01,
        targetRatio: 0.005,
        safetyMarginTokens: 32,
        segmentSourceTargetTokens: 1,
      },
      idFactory: () => finalIds.shift()!,
      restoreState: {
        currentSourceRevision: 22,
        sources: completedSources,
        phases: completedPhases,
        nodes: activeNodes,
        checkpoint: {
          ...activeResult.stateUpdate!.checkpoint,
          sourceRevision: 22,
          frontierNodeIds: checkpoint.childNodeIds,
          activePhaseId: "next-phase",
        },
      },
    });
    const completedResult = await completed.prepare({
      prompt: "Prompt",
      messages: completedMessages,
      model,
      signal: new AbortController().signal,
      sources: completedSources,
      canonicalAppendOnly: true,
    });

    const finalPhase = nodesOf(completedResult).find(
      (node) => node.level === "phase" && node.phaseId === "single-phase" && !node.checkpoint,
    );
    expect(finalPhase).toBeDefined();
    expect(completedResult.messages.at(-1)).toEqual(completedMessages.at(-1));
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
    });
    const firstResult = await first.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: firstSources,
    });
    const firstNodes = nodesOf(firstResult);
    const secondSummarizer = new FixedSummarizer();
    const second = new RuntimeContextManager({
      summarizer: secondSummarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => {
        throw new Error("A compatible node should have been reused.");
      },
      restoreState: {
        currentSourceRevision: 13,
        sources: stableSources(13),
        phases: [],
        nodes: firstNodes,
        checkpoint: firstResult.stateUpdate!.checkpoint,
      },
    });

    const secondResult = await second.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      canonicalAppendOnly: true,
    });

    expect(secondResult.path).toBe("incremental");
    expect(secondResult.stateUpdate).toBeUndefined();
    expect(secondSummarizer.requests).toHaveLength(0);
  });

  test("restores a valid checkpoint through the incremental path without rebuilding stable history", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `old ${"x".repeat(500)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(400)}` }] },
      { role: "user", content: [{ type: "text", text: "recent request" }] },
      { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
    ];
    const sources = messages.map((_, index) => ({
      messageId: `message-${index}`,
      turnId: `turn-${Math.floor(index / 2)}`,
      turnIndex: Math.floor(index / 2),
      sourceRevision: 12,
    }));
    const firstSummarizer = new FixedSummarizer();
    const first = new RuntimeContextManager({
      summarizer: firstSummarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 2, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "turn-node",
    });
    const firstResult = await first.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources,
    });
    expect(firstResult.path).toBe("rebuild");
    expect(firstResult.stateUpdate).toBeDefined();

    const secondSummarizer = new FixedSummarizer();
    const second = new RuntimeContextManager({
      summarizer: secondSummarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 2, triggerRatio: 0.01, safetyMarginTokens: 32 },
      restoreState: {
        currentSourceRevision: 13,
        sources,
        phases: [],
        nodes: nodesOf(firstResult),
        checkpoint: firstResult.stateUpdate!.checkpoint,
      },
    });
    const secondResult = await second.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      branchLineageId: "branch-1",
      canonicalAppendOnly: true,
    });

    expect(secondResult.path).toBe("incremental");
    expect(secondResult.stateUpdate).toBeUndefined();
    expect(secondSummarizer.requests).toHaveLength(0);
  });

  test("summarizes the oldest required Raw Tail Turn only after the budget triggers", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 10000, maxOutputTokens: 64 });
    const initialMessages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `old ${"x".repeat(500)}` }] },
      { role: "assistant", content: [{ type: "text", text: `answer ${"y".repeat(400)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
      { role: "assistant", content: [{ type: "text", text: "current answer" }] },
    ];
    const initialSources = initialMessages.map((_, index) => ({
      messageId: `message-${index}`,
      turnId: `turn-${Math.floor(index / 2)}`,
      turnIndex: Math.floor(index / 2),
      sourceRevision: 12,
    }));
    const first = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 2, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "old-node",
    });
    const firstResult = await first.prepare({
      prompt: "Prompt",
      messages: initialMessages,
      model,
      signal: new AbortController().signal,
      sources: initialSources,
    });
    const expandedMessages = [
      ...initialMessages,
      { role: "user", content: [{ type: "text", text: "new turn" }] } satisfies NonSystemMessage,
      { role: "assistant", content: [{ type: "text", text: `new answer ${"z".repeat(400)}` }] } satisfies NonSystemMessage,
    ];
    const expandedSources = [
      ...initialSources,
      { messageId: "message-4", turnId: "turn-2", turnIndex: 2, sourceRevision: 13 },
      { messageId: "message-5", turnId: "turn-2", turnIndex: 2, sourceRevision: 13 },
    ];
    const summarizer = new FixedSummarizer();
    const resumed = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 2, triggerRatio: 0.01, safetyMarginTokens: 32 },
      restoreState: {
        currentSourceRevision: 13,
        sources: initialSources,
        phases: [],
        nodes: nodesOf(firstResult),
        checkpoint: firstResult.stateUpdate!.checkpoint,
      },
    });
    const result = await resumed.prepare({
      prompt: "Prompt",
      messages: expandedMessages,
      model,
      signal: new AbortController().signal,
      sources: expandedSources,
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("incremental");
    expect(result.compactedTurnCount).toBe(1);
    expect(result.stateUpdate?.appendNodes).toHaveLength(1);
    expect(summarizer.requests).toHaveLength(1);
  });

  test("extends the minimal Raw Tail prefix when actual summaries remain above the target budget", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 1000, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "old request one" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer one" }] },
      { role: "user", content: [{ type: "text", text: "old request two" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer two" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ];
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      estimator: new PredictableEstimator(120),
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        turnSummaryTargetTokens: 20,
        triggerRatio: 0.45,
        targetRatio: 0.35,
        safetyMarginTokens: 32,
      },
      idFactory: sequentialIds(),
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.compactedTurnCount).toBe(2);
    expect(result.estimatedTokens).toBeLessThanOrEqual(Math.floor((1000 - 64 - 32) * 0.35));
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
    });
    const seedResult = await seed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(12),
    });
    const incompatible = nodesOf(seedResult).map((node) => ({ ...node, summarySchemaVersion: 99 }));
    const incompatibleCheckpoint = {
      ...seedResult.stateUpdate!.checkpoint,
      summarySchemaVersion: 99,
    };
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: () => "new-node",
      restoreState: {
        currentSourceRevision: 13,
        sources: stableSources(13),
        phases: [],
        nodes: incompatible,
        checkpoint: incompatibleCheckpoint,
      },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(13),
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("rebuild");
    expect(nodesOf(result).map((node) => node.id)).toEqual(["new-node"]);
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
    });
    const seedResult = await seed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(12),
    });
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
      restoreState: {
        currentSourceRevision: 13,
        sources: stableSources(13),
        phases: [],
        nodes: nodesOf(seedResult),
        checkpoint: seedResult.stateUpdate!.checkpoint,
      },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(13),
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("rebuild");
    expect(nodesOf(result).map((node) => node.id)).toEqual(["new-node"]);
    expect(result.stateUpdate?.checkpoint.policyVersion).toBe("context-v2");
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
    });
    const seedResult = await seed.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(12),
    });
    const commits = [] as NonNullable<ContextManagerPrepareResult["stateUpdate"]>[];
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      restoreState: {
        currentSourceRevision: 13,
        sources: stableSources(13),
        phases: [],
        nodes: nodesOf(seedResult),
        checkpoint: { ...seedResult.stateUpdate!.checkpoint, sourceRevision: 13, frontierNodeIds: [] },
      },
      onStateUpdate: (update) => {
        commits.push(update);
      },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: stableSources(13),
      canonicalAppendOnly: true,
    });

    expect(result.stateUpdate?.appendNodes).toEqual([]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.checkpoint.frontierNodeIds).toEqual(["node-1"]);
  });

  test("retries uncommitted nodes after state persistence fails", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const summarizer = new FixedSummarizer();
    const attempted = [] as NonNullable<ContextManagerPrepareResult["stateUpdate"]>[];
    let fail = true;
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: sequentialIds(),
      onStateUpdate: (update) => {
        attempted.push(update);
        if (fail) throw new Error("state write failed");
      },
    });
    const input = {
      prompt: "Prompt",
      messages: longTranscript(),
      model,
      signal: new AbortController().signal,
      branchLineageId: "branch-1",
      canonicalAppendOnly: true,
    };

    await expect(manager.prepare(input)).rejects.toThrow("state write failed");
    const requestCount = summarizer.requests.length;
    fail = false;
    const result = await manager.prepare(input);

    expect(summarizer.requests).toHaveLength(requestCount);
    expect(result.stateUpdate?.appendNodes.map((node) => node.id)).toEqual(
      attempted[0]?.appendNodes.map((node) => node.id),
    );
    expect(attempted).toHaveLength(2);
  });

  test("rebuilds without reusing nodes when the Branch lineage changes", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      idFactory: sequentialIds(),
    });
    const input = {
      prompt: "Prompt",
      messages: longTranscript(),
      model,
      signal: new AbortController().signal,
      canonicalAppendOnly: true,
    };
    const first = await manager.prepare({ ...input, branchLineageId: "branch-1" });
    const firstIds = new Set(nodesOf(first).map((node) => node.id));
    const requestCount = summarizer.requests.length;

    const second = await manager.prepare({ ...input, branchLineageId: "branch-2" });

    expect(second.path).toBe("rebuild");
    expect(nodesOf(second).every((node) => !firstIds.has(node.id))).toBe(true);
    expect(summarizer.requests.length).toBeGreaterThan(requestCount);
  });

  test("does not persist summaries built from a non-canonical model message view", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 6400, maxOutputTokens: 64 });
    const commits = [] as NonNullable<ContextManagerPrepareResult["stateUpdate"]>[];
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, activeTurnRecentBlocks: 1, triggerRatio: 0.01, safetyMarginTokens: 32 },
      onStateUpdate: (update) => {
        commits.push(update);
      },
    });

    const result = await manager.prepare({
      prompt: "Prompt",
      messages: longTranscript().slice(1),
      model,
      signal: new AbortController().signal,
      canonicalAppendOnly: false,
    });

    expect(result.path).toBe("rebuild");
    expect(result.stateUpdate).toBeUndefined();
    expect(summarizer.requests.length).toBeGreaterThan(0);
    expect(commits).toEqual([]);
  });

  test("keeps appended Turns raw when frontier plus Raw Tail stays below the trigger budget", async () => {
    const { provider } = createScriptedProvider([]);
    const compactModel = new Model("compact-model", provider, {}, { contextWindowTokens: 1200, maxOutputTokens: 64 });
    const roomyModel = new Model("roomy-model", provider, {}, { contextWindowTokens: 50000, maxOutputTokens: 64 });
    const initialMessages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `old ${"x".repeat(900)}` }] },
      { role: "assistant", content: [{ type: "text", text: `old answer ${"y".repeat(500)}` }] },
      { role: "user", content: [{ type: "text", text: "current" }] },
    ];
    const initialSources = sourceMessages(initialMessages, 1);
    const first = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: { recentTurns: 1, triggerRatio: 0.2, targetRatio: 0.1, safetyMarginTokens: 32 },
      idFactory: sequentialIds(),
    });
    const firstResult = await first.prepare({
      prompt: "Prompt",
      messages: initialMessages,
      model: compactModel,
      signal: new AbortController().signal,
      sources: initialSources,
    });
    expect(firstResult.stateUpdate).toBeDefined();

    const appended = { role: "assistant", content: [{ type: "text", text: "new raw answer" }] } satisfies NonSystemMessage;
    const messages = [...initialMessages, appended];
    const sources = sourceMessages(messages, 2);
    const summarizer = new FixedSummarizer();
    const resumed = new RuntimeContextManager({
      summarizer,
      policy: { recentTurns: 1, triggerRatio: 0.2, targetRatio: 0.1, safetyMarginTokens: 32 },
      restoreState: {
        currentSourceRevision: 2,
        sources,
        phases: [],
        nodes: nodesOf(firstResult),
        checkpoint: firstResult.stateUpdate!.checkpoint,
      },
    });
    const result = await resumed.prepare({
      prompt: "Prompt",
      messages,
      model: roomyModel,
      signal: new AbortController().signal,
      sources,
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("incremental");
    expect(result.stateUpdate).toBeUndefined();
    expect(result.messages.at(-1)).toEqual(appended);
    expect(summarizer.requests).toHaveLength(0);
  });

  test("uses the incremental frontier even when unreachable old-policy nodes remain stored", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 50000, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "old request" }] },
      { role: "assistant", content: [{ type: "text", text: "old answer" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ];
    const sources = sourceMessages(messages, 3);
    const validNode = turnNode("valid", sources, 0, 1, "context-v1");
    const unreachable = { ...turnNode("unreachable", sources, 0, 1, "context-v0"), renderedText: "obsolete" };
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      restoreState: restoreWithFrontier(3, sources, [validNode, unreachable], [validNode.id]),
    });
    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources,
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("incremental");
    expect(result.stateUpdate).toBeUndefined();
    expect(summarizer.requests).toHaveLength(0);
  });

  test("keeps incremental preparation bounded for a 10,000-message stable historical prefix", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 100000, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "historical request" }] },
      ...Array.from({ length: 9998 }, (_, index) => ({
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `historical answer ${index}` }],
      })),
      { role: "user", content: [{ type: "text", text: "current request" }] },
    ];
    const sources = messages.map((_, index) => ({
      messageId: `message-${index}`,
      turnId: index < 9999 ? "historical-turn" : "current-turn",
      turnIndex: index < 9999 ? 0 : 1,
      sourceRevision: 4,
    }));
    const node = turnNode("historical", sources, 0, 9998, "context-v1");
    const estimator = new CountingEstimator();
    const manager = new RuntimeContextManager({
      estimator,
      restoreState: restoreWithFrontier(4, sources, [node], [node.id]),
    });
    const guardedSources = new Proxy(sources, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("Fast path iterated the complete source snapshot");
        return Reflect.get(target, property, receiver);
      },
    });
    estimator.messageCount = 0;
    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources: guardedSources,
      canonicalAppendOnly: true,
    });

    expect(result.path).toBe("incremental");
    expect(estimator.messageCount).toBeLessThan(20);
  });

  test("persists a new historical frontier when the same prepare also compacts the current Turn", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 900, maxOutputTokens: 64 });
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `old ${"x".repeat(900)}` }] },
      { role: "assistant", content: [{ type: "text", text: `old answer ${"y".repeat(500)}` }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
      toolUseMessage("call-1", "read_file"),
      toolResultMessage("call-1", "a".repeat(900)),
      toolUseMessage("call-2", "read_file"),
      toolResultMessage("call-2", "b".repeat(900)),
      toolUseMessage("call-3", "read_file"),
      toolResultMessage("call-3", "c".repeat(900)),
    ];
    const sources = sourceMessages(messages, 5);
    const commits = [] as NonNullable<ContextManagerPrepareResult["stateUpdate"]>[];
    const summarizer = new FixedSummarizer();
    const manager = new RuntimeContextManager({
      summarizer,
      policy: {
        recentTurns: 1,
        activeTurnRecentBlocks: 1,
        triggerRatio: 0.2,
        targetRatio: 0.1,
        safetyMarginTokens: 32,
      },
      restoreState: emptyRestoreState(5, sources),
      idFactory: sequentialIds(),
      onStateUpdate: (update) => {
        commits.push(update);
      },
    });
    const first = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
      sources,
      branchLineageId: "branch-1",
      canonicalAppendOnly: true,
    });

    expect(first.stateUpdate?.appendNodes.length).toBeGreaterThan(0);
    expect(commits).toEqual([first.stateUpdate!]);
    expect(summarizer.requests.some((request) => request.level === "turn_checkpoint")).toBe(true);
    expect(first.messages.some((message) => JSON.stringify(message).includes("current request"))).toBe(true);

    const expandedMessages = [
      ...messages,
      toolUseMessage("call-4", "read_file"),
      toolResultMessage("call-4", "d".repeat(900)),
    ];
    const expandedSources = sourceMessages(expandedMessages, 6);
    manager.updateSources(expandedSources, 6, [], first.stateUpdate!.checkpoint);
    const previousCheckpointRequests = summarizer.requests.filter((request) => request.level === "turn_checkpoint").length;
    const second = await manager.prepare({
      prompt: "Prompt",
      messages: expandedMessages,
      model,
      signal: new AbortController().signal,
      sources: expandedSources,
      branchLineageId: "branch-1",
      canonicalAppendOnly: true,
    });
    const currentCheckpointRequests = summarizer.requests.filter((request) => request.level === "turn_checkpoint");

    expect(second.path).toBe("incremental");
    expect(currentCheckpointRequests).toHaveLength(previousCheckpointRequests + 1);
    expect(currentCheckpointRequests.at(-1)?.sourceText).toContain("Context Summary: turn_checkpoint");
    expect(currentCheckpointRequests.at(-1)?.sourceText).toContain("call-3");
    expect(currentCheckpointRequests.at(-1)?.sourceText).not.toContain("call-1");
  });

  test("compresses the oldest protected historical Turn only when the hard input budget requires it", async () => {
    const { provider } = createScriptedProvider([]);
    const model = new Model("test-model", provider, {}, { contextWindowTokens: 650, maxOutputTokens: 64 });
    const currentUser = { role: "user", content: [{ type: "text", text: "keep current raw" }] } satisfies NonSystemMessage;
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: `one ${"x".repeat(700)}` }] },
      { role: "assistant", content: [{ type: "text", text: `one answer ${"y".repeat(300)}` }] },
      { role: "user", content: [{ type: "text", text: `two ${"x".repeat(700)}` }] },
      { role: "assistant", content: [{ type: "text", text: `two answer ${"y".repeat(300)}` }] },
      currentUser,
    ];
    const manager = new RuntimeContextManager({
      summarizer: new FixedSummarizer(),
      policy: {
        recentTurns: 3,
        activeTurnRecentBlocks: 3,
        triggerRatio: 0.5,
        targetRatio: 0.3,
        safetyMarginTokens: 32,
      },
      idFactory: sequentialIds(),
    });
    const result = await manager.prepare({
      prompt: "Prompt",
      messages,
      model,
      signal: new AbortController().signal,
    });

    expect(result.compactedTurnCount).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(currentUser);
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

function nodesOf(result: ContextManagerPrepareResult) {
  return result.stateUpdate?.appendNodes ?? [];
}

function frontierOf(result: ContextManagerPrepareResult) {
  return result.stateUpdate?.checkpoint.frontierNodeIds ?? [];
}

function emptyRestoreState(
  sourceRevision: number,
  sources: ContextSourceMessage[],
  phases: ContextPhaseState[] = [],
): ContextRestoreState {
  return {
    currentSourceRevision: sourceRevision,
    sources,
    phases,
    nodes: [],
    checkpoint: {
      sourceRevision,
      frontierNodeIds: [],
      activePhaseId: phases.find((phase) => phase.status === "active")?.id ?? null,
      nextPhaseObjective: null,
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

function restoreWithFrontier(
  sourceRevision: number,
  sources: ContextSourceMessage[],
  nodes: CompactionNode[],
  frontierNodeIds: string[],
): ContextRestoreState {
  return {
    currentSourceRevision: sourceRevision,
    sources,
    phases: [],
    nodes,
    checkpoint: {
      sourceRevision,
      frontierNodeIds,
      activePhaseId: null,
      nextPhaseObjective: null,
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
  };
}

function turnNode(
  id: string,
  sources: ContextSourceMessage[],
  firstMessageIndex: number,
  lastMessageIndex: number,
  policyVersion: string,
): CompactionNode {
  const first = sources[firstMessageIndex]!;
  const last = sources[lastMessageIndex]!;
  return {
    id,
    level: "turn",
    checkpoint: false,
    source: {
      firstMessageIndex,
      lastMessageIndex,
      firstTurnIndex: first.turnIndex,
      lastTurnIndex: last.turnIndex,
      firstMessageId: first.messageId,
      lastMessageId: last.messageId,
      firstTurnId: first.turnId,
      lastTurnId: last.turnId,
      sourceRevision: first.sourceRevision,
    },
    childNodeIds: [],
    summary: {
      objectives: [],
      constraints: [],
      decisions: [],
      progress: [],
      results: [],
      artifacts: [],
      pending: [],
    },
    renderedText: `Context Summary: ${id}`,
    estimatedTokens: 16,
    summarySchemaVersion: 1,
    policyVersion,
    generatedBy: { model: "test-model" },
    generationUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    createdAt: "2026-08-28T00:00:00.000Z",
  };
}

function sourceMessages(messages: NonSystemMessage[], sourceRevision: number): ContextSourceMessage[] {
  let turnIndex = -1;
  return messages.map((message, messageIndex) => {
    if (message.role === "user") turnIndex++;
    return {
      messageId: `source-${messageIndex}`,
      turnId: `source-turn-${Math.max(0, turnIndex)}`,
      turnIndex: Math.max(0, turnIndex),
      sourceRevision,
    };
  });
}

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
