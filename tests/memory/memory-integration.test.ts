import { describe, expect, test } from "bun:test";

import {
  createFakeMemoryAdapter,
  createMemoryIntegration,
  DEFAULT_MEMORY_LIMITS,
  MemoryService,
  projectMemoryScope,
  type MemoryPolicy,
} from "@/memory";
import { TokenEstimator } from "@/runtime";

function policy(access: MemoryPolicy["access"], autoWrite: boolean): MemoryPolicy {
  return { access, autoWrite, limits: DEFAULT_MEMORY_LIMITS, failureMode: "best_effort" };
}

function serviceWith(initial: Record<string, string> = {}) {
  const scope = projectMemoryScope("demo", "/cwd");
  const adapter = createFakeMemoryAdapter({ [scope.projectId]: initial });
  const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
  return { scope, adapter, service };
}

function createProjectIntegration(service: MemoryService, scope: ReturnType<typeof projectMemoryScope>, memoryPolicy: MemoryPolicy) {
  return createMemoryIntegration({
    service,
    policy: {
      totalBootstrapTokens: 1_800,
      layers: [{ name: "project", scope, policy: memoryPolicy, priority: 200 }],
    },
  });
}

describe("createMemoryIntegration", () => {
  test("access none registers no memory tools", () => {
    const { scope, service } = serviceWith();
    const result = createProjectIntegration(service, scope, policy("none", false));
    expect(result.tools).toHaveLength(0);
    expect(result.middleware).toBeUndefined();
  });

  test("read registers only memory_read", () => {
    const { scope, service } = serviceWith();
    const result = createProjectIntegration(service, scope, policy("read", false));
    expect(result.tools.map((t) => t.name)).toEqual(["memory_read"]);
  });

  test("read_write with autoWrite registers both tools", () => {
    const { scope, service } = serviceWith();
    const result = createProjectIntegration(service, scope, policy("read_write", true));
    expect(result.tools.map((t) => t.name)).toEqual(["memory_read", "memory_write"]);
  });

  test("read_write without autoWrite registers only memory_read", () => {
    const { scope, service } = serviceWith();
    const result = createProjectIntegration(service, scope, policy("read_write", false));
    expect(result.tools.map((t) => t.name)).toEqual(["memory_read"]);
  });

  test("rejects invalid layer budgets, priorities, and auto-write policies", () => {
    const { scope, service } = serviceWith();
    const base = policy("read", false);
    expect(() => createMemoryIntegration({
      service,
      policy: {
        totalBootstrapTokens: 1_800,
        layers: [{ name: "project", scope, policy: { ...base, limits: { ...base.limits, bootstrapTokens: 0 } }, priority: 200 }],
      },
    })).toThrow("invalid bootstrap budget");
    expect(() => createMemoryIntegration({
      service,
      policy: {
        totalBootstrapTokens: 1_800,
        layers: [
          { name: "project", scope, policy: { ...base, access: "read_write", autoWrite: true }, priority: 200 },
          { name: "global", scope: { kind: "global", scopeId: "global" }, policy: base, priority: 200 },
        ],
      },
    })).toThrow("invalid priority");
    expect(() => createMemoryIntegration({
      service,
      policy: {
        totalBootstrapTokens: 1_800,
        layers: [{ name: "project", scope, policy: { ...base, autoWrite: true }, priority: 200 }],
      },
    })).toThrow("auto-write");
  });
});

describe("memory middleware", () => {
  test("beforeModel appends the bootstrap to the prompt", async () => {
    const { scope, service } = serviceWith({ "MEMORY.md": "# Core\n- Bun\n" });
    const integration = createProjectIntegration(service, scope, policy("read", false));
    const result = await integration.middleware?.beforeModel?.({
      modelContext: { prompt: "P", messages: [] },
      agentContext: { prompt: "P", messages: [] },
    });
    expect(result?.prompt).toContain("Project Memory");
    expect(result?.prompt).toContain("# Core");
  });

  test("beforeModel leaves the prompt untouched when the index is missing", async () => {
    const { scope, service } = serviceWith();
    const integration = createProjectIntegration(service, scope, policy("read", false));
    const result = await integration.middleware?.beforeModel?.({
      modelContext: { prompt: "P", messages: [] },
      agentContext: { prompt: "P", messages: [] },
    });
    expect(result ?? null).toBeNull();
  });

  test("middleware is dry-run compatible", () => {
    const { scope, service } = serviceWith();
    const integration = createProjectIntegration(service, scope, policy("read", false));
    expect(integration.middleware?.dryRun?.mode).toBe("compatible");
  });
});

describe("memory tools", () => {
  test("memory_read list returns summaries with short digests", async () => {
    const { scope, service } = serviceWith({ "a.md": "content" });
    const integration = createProjectIntegration(service, scope, policy("read", false));
    const readTool = integration.tools.find((t) => t.name === "memory_read")!;
    const result = (await readTool.execute({ command: "list", scope: "project" })) as { ok: boolean; data: { documents: unknown[] } };
    expect(result.ok).toBe(true);
    expect(result.data.documents).toHaveLength(1);
  });

  test("memory_write commit persists and returns the digest", async () => {
    const { scope, service } = serviceWith();
    const integration = createProjectIntegration(service, scope, policy("read_write", true));
    const writeTool = integration.tools.find((t) => t.name === "memory_write")!;
    const result = (await writeTool.execute({
      scope: "project",
      mutation: { type: "create", reference: "a.md", content: "hello" },
      expectedDigest: null,
    })) as { ok: boolean; data: { digest: string | null } };
    expect(result.ok).toBe(true);
    expect(result.data.digest).toBeTruthy();

    const readTool = integration.tools.find((t) => t.name === "memory_read")!;
    const view = (await readTool.execute({ command: "view", scope: "project", reference: "a.md" })) as {
      ok: boolean;
      data: { content: string; scope: { kind: string } };
    };
    expect(view.data.content).toBe("hello");
    expect(view.data.scope.kind).toBe("project");
  });

  test("memory_write preview (dry-run) does not modify the store", async () => {
    const { scope, service, adapter } = serviceWith({ "a.md": "one" });
    const integration = createProjectIntegration(service, scope, policy("read_write", true));
    const writeTool = integration.tools.find((t) => t.name === "memory_write")!;
    const digest = (await adapter.store.read(scope, "a.md"))!.digest;
    const preview = await writeTool.preview!(
      { scope: "project", mutation: { type: "replace", reference: "a.md", oldText: "one", newText: "two" }, expectedDigest: digest },
      { mode: "dry_run", signal: new AbortController().signal, execution: {}, toolCallId: "t" },
    );
    expect(preview.status).toBe("planned");
    expect((await adapter.store.read(scope, "a.md"))?.content).toBe("one");
  });
});
