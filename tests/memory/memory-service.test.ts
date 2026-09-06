import { describe, expect, test } from "bun:test";

import {
  createFakeMemoryAdapter,
  DEFAULT_MEMORY_LIMITS,
  MemoryService,
  projectMemoryScope,
  type MemoryPolicy,
} from "@/memory";
import { TokenEstimator } from "@/runtime";

function readPolicy(): MemoryPolicy {
  return { access: "read", autoWrite: false, limits: DEFAULT_MEMORY_LIMITS, failureMode: "best_effort" };
}

function writePolicy(): MemoryPolicy {
  return { access: "read_write", autoWrite: true, limits: DEFAULT_MEMORY_LIMITS, failureMode: "best_effort" };
}

describe("MemoryService", () => {
  test("bootstrap renders the fixed header plus the index content", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const adapter = createFakeMemoryAdapter({ [scope.projectId]: { "MEMORY.md": "# Core\n- Bun\n" } });
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });

    const bootstrap = await service.bootstrap(scope, readPolicy());
    expect(bootstrap.text).toContain("Project Memory");
    expect(bootstrap.text).toContain("<memory-index>");
    expect(bootstrap.text).toContain("# Core");
    expect(bootstrap.documentCount).toBe(1);
  });

  test("bootstrap is empty when the index is missing", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    expect(await service.bootstrap(scope, readPolicy())).toMatchObject({ text: "", documentCount: 0 });
  });

  test("bootstrap fails when the index exceeds the token budget", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const adapter = createFakeMemoryAdapter({ [scope.projectId]: { "MEMORY.md": "word ".repeat(200) } });
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
    const policy: MemoryPolicy = { ...readPolicy(), limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 10 } };
    await expect(service.bootstrap(scope, policy)).rejects.toMatchObject({ code: "MEMORY_BOOTSTRAP_TOO_LARGE" });
  });

  test("view returns a document or reports not found", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const adapter = createFakeMemoryAdapter({ [scope.projectId]: { "a.md": "content" } });
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
    expect((await service.view(scope, readPolicy(), "a.md")).content).toBe("content");
    await expect(service.view(scope, readPolicy(), "missing.md")).rejects.toMatchObject({ code: "MEMORY_NOT_FOUND" });
  });

  test("read-only policy denies writes", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    await expect(
      service.commitMutation(scope, readPolicy(), { type: "create", reference: "a.md", content: "x" }, null),
    ).rejects.toMatchObject({ code: "MEMORY_ACCESS_DENIED" });
  });

  test("commit rejects content that looks like a credential", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    await expect(
      service.commitMutation(
        scope,
        writePolicy(),
        { type: "create", reference: "a.md", content: "key sk-abcdefghijklmnopqrstuvwxyz123456" },
        null,
      ),
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_REJECTED" });
  });

  test("previewMutation computes a diff without writing", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const adapter = createFakeMemoryAdapter({ [scope.projectId]: { "a.md": "one" } });
    const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
    const digest = (await service.view(scope, readPolicy(), "a.md")).digest;
    const preview = await service.previewMutation(scope, writePolicy(), { type: "replace", reference: "a.md", oldText: "one", newText: "two" }, digest);
    expect(preview.afterDigest).toBeTruthy();
    expect(preview.noChange).toBe(false);
    // 未提交：原文不变。
    expect((await service.view(scope, readPolicy(), "a.md")).content).toBe("one");
  });

  test("preview and commit enforce caller-provided limits", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    const policy: MemoryPolicy = {
      ...writePolicy(),
      limits: { ...DEFAULT_MEMORY_LIMITS, maxDocumentBytes: 3 },
    };
    const mutation = { type: "create" as const, reference: "a.md" as const, content: "four" };
    await expect(service.previewMutation(scope, policy, mutation, null)).rejects.toMatchObject({
      code: "MEMORY_LIMIT_EXCEEDED",
    });
    await expect(service.commitMutation(scope, policy, mutation, null)).rejects.toMatchObject({
      code: "MEMORY_LIMIT_EXCEEDED",
    });
  });

  test("preview rejects a stale digest", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({
      adapter: createFakeMemoryAdapter({ [scope.projectId]: { "a.md": "one" } }),
      estimator: new TokenEstimator(),
    });
    await expect(
      service.previewMutation(
        scope,
        writePolicy(),
        { type: "replace", reference: "a.md", oldText: "one", newText: "two" },
        "stale",
      ),
    ).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
  });

  test("commit rejects disallowed control characters", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    await expect(
      service.commitMutation(
        scope,
        writePolicy(),
        { type: "create", reference: "a.md", content: "safe\u0000unsafe" },
        null,
      ),
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_REJECTED" });
  });

  test("fake adapter inspection does not materialize an empty scope", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    expect(await service.inspect(scope, readPolicy())).toMatchObject({ materialized: false, documents: [] });
  });

  test("rejects malformed scope values with a stable memory error", async () => {
    const service = new MemoryService({ adapter: createFakeMemoryAdapter(), estimator: new TokenEstimator() });
    await expect(service.inspect(undefined as never, readPolicy())).rejects.toMatchObject({ code: "MEMORY_SCOPE_INVALID" });
  });

  test("cross-session: a second service over the same adapter sees committed memory", async () => {
    const scope = projectMemoryScope("demo", "/cwd");
    const adapter = createFakeMemoryAdapter();
    const serviceA = new MemoryService({ adapter, estimator: new TokenEstimator() });
    await serviceA.commitMutation(scope, writePolicy(), { type: "create", reference: "a.md", content: "kept" }, null);

    const serviceB = new MemoryService({ adapter, estimator: new TokenEstimator() });
    expect((await serviceB.view(scope, readPolicy(), "a.md")).content).toBe("kept");
  });
});
