import { describe, expect, test } from "bun:test";

import type { UserMessage } from "@/core";
import type { CompactionNode, ExecutionResult } from "@/runtime";
import { MemorySessionStore, resolveSessionSelector, SessionError, SessionService } from "@/sessions";
import type { EffectiveModelSnapshot, SessionRecord } from "@/sessions/session-types";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "55555555-5555-4555-8555-555555555555";
const NEXT_TURN_ID = "66666666-6666-4666-8666-666666666666";
const AGENT_GROUP = { id: "default-coding", revision: "a".repeat(64) };
const TEST_CWD = process.cwd();
const TEST_PROJECT_KEY = TEST_CWD.toLowerCase();

const model: EffectiveModelSnapshot = {
  configId: MODEL_ID,
  configName: "work",
  provider: "openai",
  model: "gpt-4o",
};

describe("SessionService with MemorySessionStore", () => {
  test("drafts are not listed until materialized", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    const draft = createDraft(service);
    expect(await store.list()).toEqual([]);

    const record = await service.materialize(draft);
    expect(record.revision).toBe(1);
    expect(record.compaction).toEqual({
      version: 1,
      phases: [],
      nodes: [],
      checkpoint: {
        sourceRevision: 1,
        frontierNodeIds: [],
        policyVersion: "context-v1",
        summarySchemaVersion: 1,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    });
    expect(await store.list()).toHaveLength(1);
  });

  test("records user messages, terminal turn metadata and sanitized errors", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    let session = await service.materialize(createDraft(service));
    const started = await service.beginTurn(session, AGENT_GROUP);
    session = started.record;

    const message: UserMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
    session = await service.appendMessages(session.id, started.turn.id, [message]);

    const result: ExecutionResult = {
      executionId: "root",
      branchId: "root",
      rootExecutionId: "root",
      agentId: "agent",
      status: "failed",
      mode: "execute",
      steps: 1,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, usageIncomplete: false },
      durationMs: 10,
      error: { code: "MODEL_FAILED", message: "provider failed with sk-secret-value", retryable: false },
    };
    session = await service.finishTurn(session.id, started.turn.id, result, [
      { ...model, executionId: "root", agentId: "agent" },
    ]);

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]?.turnId).toBe(started.turn.id);
    expect(session.turns[0]?.status).toBe("failed");
    expect(session.turns[0]?.usage?.totalTokens).toBe(3);
    expect(session.turns[0]?.error?.message).not.toContain("sk-secret-value");
  });

  test("persists a committed handoff and advances the active Agent", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    const session = await service.materialize(createDraft(service));
    const started = await service.beginTurn(session, AGENT_GROUP);
    const record = {
      sourceExecutionId: "root",
      successorExecutionId: "reviewer-execution",
      sourceAgentId: "code",
      targetAgentId: "reviewer",
      sequence: 1,
      committedAt: 100,
    };

    const advanced = await service.recordHandoff(session.id, started.turn.id, record);

    expect(advanced.activeAgentId).toBe("reviewer");
    expect(advanced.turns[0]?.handoffs).toEqual([record]);
  });

  test("rename, Agent model override and clear preserve session identity", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    let session = await service.materialize(createDraft(service));
    const originalId = session.id;

    session = await service.rename(session, "Renamed");
    expect(session.id).toBe(originalId);
    expect(session.name).toBe("Renamed");

    const otherModelId = "66666666-6666-4666-8666-666666666666";
    session = await service.setAgentModelOverride(session, "code", otherModelId);
    expect(session.id).toBe(originalId);
    expect(session.agentModelOverrides).toEqual({ code: otherModelId });

    const started = await service.beginTurn(session, AGENT_GROUP);
    await service.appendMessages(session.id, started.turn.id, [
      { role: "user", content: [{ type: "text", text: "x" }] },
    ]);
    session = await service.clear(started.record);
    expect(session.id).toBe(originalId);
    expect(session.messages).toEqual([]);
  });

  test("persists compaction nodes as derived session state and clears them with the transcript", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    let session = await service.materialize(createDraft(service));

    session = await service.appendCompactionNodes(session.id, {
      nodes: [compactionNode("node-1")],
      frontierNodeIds: ["node-1"],
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      sourceRevision: session.revision,
    });
    expect(session.compaction.version).toBe(1);
    expect(session.compaction.nodes.map((node) => node.id)).toEqual(["node-1"]);
    expect(session.compaction.checkpoint.frontierNodeIds).toEqual(["node-1"]);

    session = await service.appendCompactionNodes(session.id, {
      nodes: [compactionNode("node-2")],
      frontierNodeIds: ["node-2"],
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      sourceRevision: session.revision,
    });
    expect(session.compaction.nodes.map((node) => node.id)).toEqual(["node-1", "node-2"]);
    expect(session.compaction.checkpoint.frontierNodeIds).toEqual(["node-2"]);

    session = await service.clear(session);
    expect(session.compaction.nodes).toEqual([]);
    expect(session.compaction.checkpoint.frontierNodeIds).toEqual([]);
  });

  test("persists Phase checkpoints and updates the frontier without creating another node", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    let session = await service.materialize(createDraft(service));
    const checkpoint = { ...compactionNode("phase-checkpoint"), level: "phase" as const, checkpoint: true };

    session = await service.appendCompactionNodes(session.id, {
      nodes: [checkpoint],
      frontierNodeIds: [checkpoint.id],
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      sourceRevision: session.revision,
    });
    const checkpointRevision = session.revision;
    expect(session.compaction.nodes).toContainEqual(checkpoint);

    session = await service.appendCompactionNodes(session.id, {
      nodes: [],
      frontierNodeIds: [],
      policyVersion: "context-v1",
      summarySchemaVersion: 1,
      sourceRevision: session.revision,
    });
    expect(session.revision).toBe(checkpointRevision + 1);
    expect(session.compaction.nodes).toContainEqual(checkpoint);
    expect(session.compaction.checkpoint.frontierNodeIds).toEqual([]);
  });

  test("initializes and transitions compaction phases", async () => {
    const store = new MemorySessionStore();
    const service = makeService(store);
    let session = await service.materialize(createDraft(service));

    session = await service.ensureCompactionState(session.id, TURN_ID, "context-v1");
    expect(session.compaction.phases).toHaveLength(1);
    expect(session.compaction.phases[0]?.status).toBe("active");

    session = await service.transitionCompactionPhase(session.id, TURN_ID, "next objective", "context-v1");
    expect(session.compaction.phases.map((phase) => phase.status)).toEqual(["completed"]);
    expect(session.compaction.checkpoint.nextPhaseObjective).toBe("next objective");
    expect(session.compaction.checkpoint.activePhaseId).toBeUndefined();

    session = await service.ensureCompactionState(session.id, NEXT_TURN_ID, "context-v1");
    expect(session.compaction.phases.map((phase) => phase.status)).toEqual(["completed", "active"]);
    expect(session.compaction.phases[1]?.objective).toBe("next objective");
    expect(session.compaction.phases[1]?.startedTurnId).toBe(NEXT_TURN_ID);
    expect(session.compaction.checkpoint.nextPhaseObjective).toBeUndefined();
  });

  test("selector resolves id, unique prefix and exact name, and rejects ambiguity", async () => {
    const first = makeRecord({ id: SESSION_ID, name: "same" });
    const second = makeRecord({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "same" });
    const store = new MemorySessionStore([first, second]);
    const summaries = await store.list({ includeAllProjects: true });

    expect(resolveSessionSelector(SESSION_ID, summaries).id).toBe(SESSION_ID);
    expect(resolveSessionSelector("11111111", summaries).id).toBe(SESSION_ID);
    expect(() => resolveSessionSelector("same", summaries)).toThrow(SessionError);
  });

  test("CAS prevents silent overwrite", async () => {
    const store = new MemorySessionStore();
    const lease = await store.acquire(SESSION_ID, { create: true });
    const record = makeRecord({ id: SESSION_ID, revision: 1 });
    await store.commit(lease, 0, record);
    await expect(store.commit(lease, 0, { ...record, revision: 1 })).rejects.toThrow(SessionError);
    await lease.release();
  });
});

function makeService(store: MemorySessionStore) {
  return new SessionService({
    store,
    clock: { now: () => "2026-08-27T00:00:00.000Z" },
    ids: {
      sessionId: () => SESSION_ID,
      turnId: () => TURN_ID,
      messageId: () => MESSAGE_ID,
      ownerId: () => OWNER_ID,
    },
  });
}

function createDraft(service: SessionService) {
  return service.createDraft({
    cwd: TEST_CWD,
    activeAgentGroupId: AGENT_GROUP.id,
    activeAgentId: "code",
  });
}

function compactionNode(id: string): CompactionNode {
  return {
    id,
    level: "turn",
    checkpoint: false,
    source: { firstMessageIndex: 0, lastMessageIndex: 1, firstTurnIndex: 0, lastTurnIndex: 0 },
    childNodeIds: [],
    summary: {
      objectives: ["objective"],
      constraints: [],
      decisions: [],
      progress: ["progress"],
      results: [],
      artifacts: [],
      pending: [],
    },
    renderedText: "Context Summary: turn",
    estimatedTokens: 8,
    summarySchemaVersion: 1,
    policyVersion: "context-v1",
    generatedBy: { model: "gpt-4o" },
    generationUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, usageIncomplete: false },
    createdAt: "2026-08-27T00:00:00.000Z",
  };
}

function makeRecord(input: { id: string; name?: string | null; revision?: number }): SessionRecord {
  return {
    id: input.id,
    revision: input.revision ?? 1,
    name: input.name ?? null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    workspace: { cwd: TEST_CWD, projectKey: TEST_PROJECT_KEY },
    activeAgentGroupId: AGENT_GROUP.id,
    activeAgentId: "code",
    agentModelOverrides: {},
    activeExecutionMode: "execute",
    messages: [],
    turns: [],
    compaction: {
      version: 1,
      phases: [],
      nodes: [],
      checkpoint: {
        sourceRevision: input.revision ?? 1,
        frontierNodeIds: [],
        policyVersion: "context-v1",
        summarySchemaVersion: 1,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    },
  };
}
