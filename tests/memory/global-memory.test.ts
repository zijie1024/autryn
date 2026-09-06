import { describe, expect, test } from "bun:test";

import {
  createFakeMemoryAdapter,
  createMemoryIntegration,
  globalMemoryScope,
  MemoryService,
  projectMemoryScope,
} from "@/memory";
import { TokenEstimator } from "@/runtime";

describe("Global Memory", () => {
  test("stores global and project documents independently", async () => {
    const adapter = createFakeMemoryAdapter();
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
    const global = globalMemoryScope();
    const project = projectMemoryScope("demo", "/workspace/demo");
    const policy = { access: "read_write" as const, autoWrite: true, limits: { bootstrapTokens: 600, maxDocumentBytes: 10000, maxDocumentsPerScope: 20, maxScopeBytes: 50000 }, failureMode: "best_effort" as const };
    await service.commitMutation(global, policy, { type: "create", reference: "MEMORY.md", content: "# Global\n" }, null);
    await service.commitMutation(project, policy, { type: "create", reference: "MEMORY.md", content: "# Project\n" }, null);
    expect((await service.view(global, policy, "MEMORY.md")).content).toContain("Global");
    expect((await service.view(project, policy, "MEMORY.md")).content).toContain("Project");
  });

  test("builds Global then Project context and lists both scopes explicitly", async () => {
    const global = globalMemoryScope();
    const project = projectMemoryScope("demo", "/workspace/demo");
    const adapter = createFakeMemoryAdapter({
      global: { "MEMORY.md": "# Shared\n", "preferences.md": "Concise output.\n" },
      [project.projectId]: { "MEMORY.md": "# Project\n", "architecture.md": "Layered.\n" },
    });
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
    const integration = createMemoryIntegration({
      service,
      policy: {
        totalBootstrapTokens: 1_800,
        layers: [
          { name: "project", scope: project, policy: layeredPolicy("read", false, 1_200), priority: 200 },
          { name: "global", scope: global, policy: layeredPolicy("read_write", true, 600), priority: 100 },
        ],
      },
    });

    const prepared = await integration.middleware!.beforeModel!({
      modelContext: { prompt: "P", messages: [] },
      agentContext: { prompt: "P", messages: [] },
    });
    expect(prepared?.prompt?.indexOf('scope="global"')).toBeLessThan(prepared?.prompt?.indexOf('scope="project"') ?? 0);

    const read = integration.tools.find((tool) => tool.name === "memory_read")!;
    const listed = await read.execute({ command: "list", scope: "all" }) as {
      data: { scopes: Array<{ scope: string; documents: unknown[] }> };
    };
    expect(listed.data.scopes.map((scope) => scope.scope)).toEqual(["global", "project"]);
    expect(listed.data.scopes.map((scope) => scope.documents.length)).toEqual([2, 2]);

    const write = integration.tools.find((tool) => tool.name === "memory_write")!;
    expect(write.parameters.safeParse({
      scope: "global",
      mutation: { type: "create", reference: "new.md", content: "new" },
      expectedDigest: null,
    }).success).toBe(true);
    expect(write.parameters.safeParse({
      scope: "project",
      mutation: { type: "create", reference: "new.md", content: "new" },
      expectedDigest: null,
    }).success).toBe(false);
  });

  test("rejects layer budgets that exceed the combined budget", () => {
    const global = globalMemoryScope();
    const project = projectMemoryScope("demo", "/workspace/demo");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    expect(() => createMemoryIntegration({
      service,
      policy: {
        totalBootstrapTokens: 1_000,
        layers: [
          { name: "global", scope: global, policy: layeredPolicy("read", false, 600), priority: 100 },
          { name: "project", scope: project, policy: layeredPolicy("read", false, 600), priority: 200 },
        ],
      },
    })).toThrow("exceed the combined bootstrap budget");
  });
});

function layeredPolicy(access: "read" | "read_write", autoWrite: boolean, bootstrapTokens: number) {
  return {
    access,
    autoWrite,
    limits: { bootstrapTokens, maxDocumentBytes: 10_000, maxDocumentsPerScope: 20, maxScopeBytes: 50_000 },
    failureMode: "best_effort" as const,
  };
}
