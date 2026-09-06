import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { Model } from "@/core";
import type { HandoffEvent } from "@/runtime";
import { FileSessionStore, MemorySessionStore, sessionDirectory } from "@/sessions";
import { AgentRegistry } from "@/terminal/session/agent-registry";
import { ModelResolver } from "@/terminal/session/model-resolver";
import { contextSources, SessionController } from "@/terminal/session/session-controller";

import { createScriptedProvider, finalTextMessage, finalToolUseMessage } from "../../runtime/fake-provider";

const MODEL_A = "11111111-1111-4111-8111-111111111111";
const MODEL_B = "22222222-2222-4222-8222-222222222222";
let roots: string[] = [];
const originalAutrynHome = Bun.env.AUTRYN_HOME;

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
  if (originalAutrynHome === undefined) delete Bun.env.AUTRYN_HOME;
  else Bun.env.AUTRYN_HOME = originalAutrynHome;
});

describe("SessionController", () => {
  test("maps persisted messages to their Phase status and source revision", () => {
    const messages = [
      {
        id: "message-a",
        turnId: "turn-a",
        committedAt: "2026-08-28T00:00:00.000Z",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
      },
      {
        id: "message-b",
        turnId: "turn-b",
        committedAt: "2026-08-28T00:00:01.000Z",
        message: { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      },
    ];
    const phases = [
      {
        id: "phase-a",
        status: "completed" as const,
        objective: "first",
        startedTurnId: "turn-a",
        endedTurnId: "turn-a",
        createdAt: "2026-08-28T00:00:00.000Z",
        completedAt: "2026-08-28T00:00:00.500Z",
      },
      {
        id: "phase-b",
        status: "active" as const,
        objective: "second",
        startedTurnId: "turn-b",
        createdAt: "2026-08-28T00:00:01.000Z",
      },
    ];

    expect(contextSources(messages, 12, phases)).toEqual([
      {
        messageId: "message-a",
        turnId: "turn-a",
        turnIndex: 0,
        phaseId: "phase-a",
        phaseStatus: "completed",
        sourceRevision: 12,
      },
      {
        messageId: "message-b",
        turnId: "turn-b",
        turnIndex: 1,
        phaseId: "phase-b",
        phaseStatus: "active",
        sourceRevision: 12,
      },
    ]);
  });

  test("plain construction starts an unsaved draft with the default model", () => {
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    const snapshot = controller.snapshot();
    expect(snapshot.materialized).toBe(false);
    expect(snapshot.activeModelName).toBe("model-a");
    expect(snapshot.activeExecutionMode).toBe("execute");
    expect(snapshot.activeAgentId).toBe("code");
    expect(snapshot.activeAgentMissing).toBe(false);
    expect(snapshot.messageCount).toBe(0);
  });

  test("switchModel preserves session id and applies to the next turn", async () => {
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    const id = controller.snapshot().id;
    const result = await controller.switchModel("model-b");
    expect(result.appliesAfterCurrentTurn).toBe(false);
    expect(controller.snapshot().id).toBe(id);
    expect(controller.snapshot().activeModelName).toBe("model-b");
    expect(controller.snapshot().materialized).toBe(true);
  });

  test("draft materialization attaches before the first persisted mutation releases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autryn-controller-sessions-"));
    roots.push(root);
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner", heartbeatIntervalMs: 0 });
    const controller = new SessionController({
      store,
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    const id = controller.snapshot().id;
    await controller.switchModel("model-b");

    expect(await Bun.file(path.join(sessionDirectory(root, id), "lease.json")).exists()).toBe(true);
    await controller.dispose();
    expect(await Bun.file(path.join(sessionDirectory(root, id), "lease.json")).exists()).toBe(false);
  });

  test("newDraft creates a different identity and returns to the default model", async () => {
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    await controller.switchModel("model-b");
    const old = controller.snapshot().id;
    await controller.newDraft();
    expect(controller.snapshot().id).not.toBe(old);
    expect(controller.snapshot().activeModelName).toBe("model-a");
    expect(controller.snapshot().materialized).toBe(false);
  });

  test("model descriptors do not expose API keys", () => {
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    expect(JSON.stringify(controller.modelDescriptors())).not.toContain("sk-secret");
  });

  test("switchExecutionMode preserves session id and applies to the next turn", async () => {
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: new ModelResolver(config()),
      cwd: process.cwd(),
    });
    const id = controller.snapshot().id;
    const result = await controller.switchExecutionMode("dry_run");
    expect(result.appliesAfterCurrentTurn).toBe(false);
    expect(controller.snapshot().id).toBe(id);
    expect(controller.snapshot().activeExecutionMode).toBe("dry_run");
    expect(controller.snapshot().materialized).toBe(true);
  });

  test("a committed handoff selects the successor Agent for the next turn", async () => {
    const autrynHome = await mkdtemp(path.join(tmpdir(), "autryn-controller-home-"));
    roots.push(autrynHome);
    Bun.env.AUTRYN_HOME = autrynHome;
    const reviewer = createScriptedProvider([
      () => [finalTextMessage("reviewed")],
      () => [finalTextMessage("continued as reviewer")],
    ]);
    const codeProvider = createScriptedProvider([
      () => [finalToolUseMessage([{ id: "handoff", name: "handoff_to_reviewer", input: { reason: "ready" } }])],
    ]);
    const configured = handoffConfig();
    const resolver = new ModelResolver(configured);
    resolver.resolve = (id: string) => {
      const entry = configured.models.find((candidate) => candidate.id === id)!;
      return {
        entry,
        model: new Model(entry.model, id === MODEL_A ? codeProvider.provider : reviewer.provider),
        effective: { configId: entry.id, configName: entry.name, provider: entry.provider, model: entry.model },
      };
    };
    const registry = new AgentRegistry(configured, resolver);
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: resolver,
      cwd: process.cwd(),
      agentRegistry: registry,
    });

    const handoffEvents: HandoffEvent[] = [];
    const first = await controller.runTurn("review this", {
      onHandoff: (event) => handoffEvents.push(event),
    });
    expect(first).toMatchObject({ finalAgentId: "reviewer", status: "completed" });
    expect("materialized" in controller.session ? null : controller.session.revision).toBe(4);
    expect(handoffEvents.map((event) => event.status)).toEqual(["requested", "committed"]);
    expect(handoffEvents.at(-1)).toMatchObject({ agentId: "code", targetAgentId: "reviewer" });
    expect(controller.snapshot()).toMatchObject({ activeAgentId: "reviewer", activeAgentMissing: false });
    expect("materialized" in controller.session ? [] : controller.session.turns[0]?.effectiveModels).toEqual([
      expect.objectContaining({ agentId: "code", configId: MODEL_A }),
      expect.objectContaining({ agentId: "reviewer", configId: MODEL_B }),
    ]);

    const second = await controller.runTurn("continue");
    expect(second).toMatchObject({ initialAgentId: "reviewer", finalAgentId: "reviewer", status: "completed" });
    expect(second.output?.text).toBe("continued as reviewer");
  });

  test("records the actual Model used by a delegated Child Execution", async () => {
    const autrynHome = await mkdtemp(path.join(tmpdir(), "autryn-controller-home-"));
    roots.push(autrynHome);
    Bun.env.AUTRYN_HOME = autrynHome;
    const reviewer = createScriptedProvider([() => [finalTextMessage("reviewed")]]);
    const codeProvider = createScriptedProvider([
      () => [
        finalToolUseMessage([{ id: "delegate", name: "delegate_task", input: { agent: "reviewer", task: "review" } }]),
      ],
      () => [finalTextMessage("completed")],
    ]);
    const configured = delegationConfig();
    const resolver = new ModelResolver(configured);
    resolver.resolve = (id: string) => {
      const entry = configured.models.find((candidate) => candidate.id === id)!;
      return {
        entry,
        model: new Model(entry.model, id === MODEL_A ? codeProvider.provider : reviewer.provider),
        effective: { configId: entry.id, configName: entry.name, provider: entry.provider, model: entry.model },
      };
    };
    const controller = new SessionController({
      store: new MemorySessionStore(),
      modelResolver: resolver,
      cwd: process.cwd(),
      agentRegistry: new AgentRegistry(configured, resolver),
    });

    const result = await controller.runTurn("implement and review");
    expect(result).toMatchObject({ initialAgentId: "code", finalAgentId: "code", status: "completed" });
    const effectiveModels = "materialized" in controller.session ? [] : controller.session.turns[0]?.effectiveModels;
    expect(effectiveModels).toEqual([
      expect.objectContaining({ agentId: "code", configId: MODEL_A, model: "gpt-a" }),
      expect.objectContaining({ agentId: "reviewer", configId: MODEL_B, model: "gpt-b" }),
    ]);
    expect(new Set(effectiveModels?.map((entry) => entry.executionId)).size).toBe(2);
  });
});

function config() {
  return {
    models: [
      {
        id: MODEL_A,
        name: "model-a",
        model: "gpt-a",
        baseURL: "https://api.openai.com/v1",
        APIKey: "sk-secret-a",
        provider: "openai" as const,
        contextWindowTokens: 128000,
        contextCompactionMode: "off" as const,
      },
      {
        id: MODEL_B,
        name: "model-b",
        model: "gpt-b",
        baseURL: "https://api.openai.com/v1",
        APIKey: "sk-secret-b",
        provider: "openai" as const,
        contextWindowTokens: 128000,
        contextCompactionMode: "off" as const,
      },
    ],
    agentGroups: [
      {
        id: "default-coding",
        name: "Default Coding",
        entryAgentId: "code",
        defaults: { modelConfigId: MODEL_A },
        agents: [{ id: "code", name: "Code", description: "Codes", delegates: [], handoffs: [] }],
      },
    ],
    defaultAgentGroupId: "default-coding",
    defaultExecutionMode: "execute" as const,
  };
}

function handoffConfig() {
  const base = config();
  return {
    ...base,
    agentGroups: [
      {
        id: "default-coding",
        name: "Default Coding",
        entryAgentId: "code",
        agents: [
          {
            id: "code",
            name: "Code",
            description: "Implements changes",
            modelConfigId: MODEL_A,
            delegates: [],
            handoffs: [{ target: "reviewer", description: "Review the implementation" }],
          },
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Reviews changes",
            modelConfigId: MODEL_B,
            delegates: [],
            handoffs: [],
          },
        ],
      },
    ],
  };
}

function delegationConfig() {
  const base = config();
  return {
    ...base,
    agentGroups: [
      {
        id: "default-coding",
        name: "Default Coding",
        entryAgentId: "code",
        agents: [
          {
            id: "code",
            name: "Code",
            description: "Implements changes",
            modelConfigId: MODEL_A,
            delegates: [
              {
                target: "reviewer",
                description: "Review the implementation",
                tools: "target" as const,
                memory: "target" as const,
              },
            ],
            handoffs: [],
          },
          {
            id: "reviewer",
            name: "Reviewer",
            description: "Reviews changes",
            modelConfigId: MODEL_B,
            delegates: [],
            handoffs: [],
          },
        ],
      },
    ],
  };
}
