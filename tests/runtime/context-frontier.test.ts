import { describe, expect, test } from "bun:test";

import type { CompactionNode, ContextCompactionCheckpoint, ContextSourceMessage } from "@/runtime";
import { expandCompletedPhaseCheckpoints, validateFrontier } from "@/runtime/context/frontier";

describe("Context frontier validation", () => {
  test("accepts a continuous stable frontier and derives the Raw Tail start", () => {
    const sources = sourceMessages(3);
    const first = node("first", "turn", sources, 0, 0);
    const second = node("second", "turn", sources, 1, 1);
    const result = validateFrontier({
      checkpoint: checkpoint([first.id, second.id]),
      nodes: [first, second],
      sources,
      phases: [],
      currentSourceRevision: 1,
      expectedPolicyVersion: "context-v1",
      expectedSummarySchemaVersion: 1,
      requireStableAnchors: true,
    });

    expect(result?.rawTailStart).toBe(2);
  });

  test("rejects a Parent whose children leave a source gap", () => {
    const sources = sourceMessages(3);
    const first = node("first", "turn", sources, 0, 0);
    const third = node("third", "turn", sources, 2, 2);
    const parent = node("parent", "segment", sources, 0, 2, [first.id, third.id]);

    expect(
      validateFrontier({
        checkpoint: checkpoint([parent.id]),
        nodes: [first, third, parent],
        sources,
        phases: [],
        currentSourceRevision: 1,
        requireStableAnchors: true,
      }),
    ).toBeNull();
  });

  test("rejects a Session node with an indirect Active Phase descendant", () => {
    const sources = sourceMessages(1, "active-phase", "active");
    const turn = node("turn", "turn", sources, 0, 0, [], "active-phase");
    const segment = node("segment", "segment", sources, 0, 0, [turn.id], "active-phase");
    const session = node("session", "session", sources, 0, 0, [segment.id]);

    expect(
      validateFrontier({
        checkpoint: { ...checkpoint([session.id]), activePhaseId: "active-phase" },
        nodes: [turn, segment, session],
        sources,
        phases: [{ id: "active-phase", status: "active", startedTurnId: "turn-0" }],
        currentSourceRevision: 1,
        requireStableAnchors: true,
      }),
    ).toBeNull();
  });

  test("expands a completed Phase checkpoint to its persisted children", () => {
    const sources = sourceMessages(2, "phase-a", "completed");
    const first = node("first", "turn", sources, 0, 0, [], "phase-a");
    const second = node("second", "turn", sources, 1, 1, [], "phase-a");
    const phase = { ...node("phase", "phase", sources, 0, 1, [first.id, second.id], "phase-a"), checkpoint: true };

    expect(expandCompletedPhaseCheckpoints([phase.id], [first, second, phase], new Set(["phase-a"]))).toEqual([
      first.id,
      second.id,
    ]);
  });
});

function sourceMessages(
  count: number,
  phaseId?: string,
  phaseStatus?: "active" | "completed",
): ContextSourceMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `message-${index}`,
    turnId: `turn-${index}`,
    turnIndex: index,
    ...(phaseId ? { phaseId } : {}),
    ...(phaseStatus ? { phaseStatus } : {}),
    sourceRevision: 1,
  }));
}

function checkpoint(frontierNodeIds: string[]): ContextCompactionCheckpoint {
  return {
    sourceRevision: 1,
    frontierNodeIds,
    activePhaseId: null,
    nextPhaseObjective: null,
    policyVersion: "context-v1",
    summarySchemaVersion: 1,
    updatedAt: "2026-09-08T00:00:00.000Z",
  };
}

function node(
  id: string,
  level: CompactionNode["level"],
  sources: ContextSourceMessage[],
  firstMessageIndex: number,
  lastMessageIndex: number,
  childNodeIds: string[] = [],
  phaseId?: string,
): CompactionNode {
  const first = sources[firstMessageIndex]!;
  const last = sources[lastMessageIndex]!;
  return {
    id,
    level,
    ...(phaseId ? { phaseId } : {}),
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
      sourceRevision: 1,
    },
    childNodeIds,
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
    estimatedTokens: 8,
    summarySchemaVersion: 1,
    policyVersion: "context-v1",
    generatedBy: { model: "test-model" },
    generationUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    createdAt: "2026-09-08T00:00:00.000Z",
  };
}
