import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { globalMemoryScope, sha256Hex, type MemoryScope } from "@/memory";
import { FileMemoryStore } from "@/memory";

describe("FileMemoryStore", () => {
  let home: string;
  let scope: MemoryScope;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "autryn-memory-store-"));
    scope = { kind: "project", scopeId: "a".repeat(64), projectId: "a".repeat(64), projectKey: "demo", cwd: join(home, "project") };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("reads a missing scope without creating directories", async () => {
    const store = new FileMemoryStore({ home });
    expect(await store.read(scope, "MEMORY.md")).toBeNull();
    expect(await store.inspect(scope)).toMatchObject({ materialized: false, documents: [] });
  });

  test("creates, reads, and lists documents with a stable digest", async () => {
    const store = new FileMemoryStore({ home });
    const content = "# Core\n\n- Package manager: Bun.\n";
    await store.commit({ scope, mutation: { type: "create", reference: "MEMORY.md", content }, expectedDigest: null });

    const document = await store.read(scope, "MEMORY.md");
    expect(document?.content).toBe(content);
    expect(document?.digest).toBe(sha256Hex(content));

    const snapshot = await store.inspect(scope);
    expect(snapshot.materialized).toBe(true);
    expect(snapshot.documents.map((d) => d.reference)).toContain("MEMORY.md");
  });

  test("stores Global Memory in its dedicated scope with global metadata", async () => {
    const store = new FileMemoryStore({ home });
    const global = globalMemoryScope();
    await store.commit({
      scope: global,
      mutation: { type: "create", reference: "MEMORY.md", content: "# Global\n" },
      expectedDigest: null,
    });

    expect((await store.read(global, "MEMORY.md"))?.content).toBe("# Global\n");
    expect(await Bun.file(join(home, "memory", "global", "MEMORY.md")).exists()).toBe(true);
    const metadata = JSON.parse(await readFile(join(home, "memory", "global", "scope.json"), "utf8"));
    expect(metadata).toMatchObject({ schemaVersion: 1, kind: "global", scopeId: "global" });
    expect(metadata).not.toHaveProperty("projectId");
    expect(metadata).not.toHaveProperty("projectKey");
  });

  test("rejects create with a non-null expected digest", async () => {
    const store = new FileMemoryStore({ home });
    await expect(
      store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: "abc" }),
    ).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
  });

  test("rejects an update with a stale expected digest", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "one" }, expectedDigest: null });
    await expect(
      store.commit({ scope, mutation: { type: "replace", reference: "a.md", oldText: "one", newText: "two" }, expectedDigest: "stale" }),
    ).rejects.toMatchObject({ code: "MEMORY_REVISION_CONFLICT" });
  });

  test("applies replace with the correct digest", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "one" }, expectedDigest: null });
    const before = await store.read(scope, "a.md");
    const result = await store.commit({
      scope,
      mutation: { type: "replace", reference: "a.md", oldText: "one", newText: "two" },
      expectedDigest: before!.digest,
    });
    expect(result.document?.content).toBe("two");
    expect((await store.read(scope, "a.md"))?.content).toBe("two");
  });

  test("two store instances over the same home share committed state", async () => {
    const storeA = new FileMemoryStore({ home });
    await storeA.commit({ scope, mutation: { type: "create", reference: "a.md", content: "shared" }, expectedDigest: null });

    const storeB = new FileMemoryStore({ home });
    expect((await storeB.read(scope, "a.md"))?.content).toBe("shared");
  });

  // Windows 未提升权限时 `symlink()` 会 EPERM，无法在 CI 环境构造符号链接。
  if (process.platform !== "win32") {
    test("rejects a scope root that is a symbolic link", async () => {
      const real = join(home, "real");
      await mkdir(real);
      const scopeRoot = join(home, "memory", "projects", "a".repeat(64));
      await mkdir(join(home, "memory", "projects"), { recursive: true });
      await symlink(real, scopeRoot);

      const store = new FileMemoryStore({ home });
      await expect(
        store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: null }),
      ).rejects.toMatchObject({ code: "MEMORY_SYMLINK_REJECTED" });
    });
  }

  test("enforces the per-document size limit", async () => {
    const store = new FileMemoryStore({ home });
    const huge = "x".repeat(65 * 1024);
    await expect(
      store.commit({ scope, mutation: { type: "create", reference: "a.md", content: huge }, expectedDigest: null }),
    ).rejects.toMatchObject({ code: "MEMORY_LIMIT_EXCEEDED" });
  });

  test("delete and rename mutate the visible reference set", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: null });
    const before = await store.read(scope, "a.md");
    await store.commit({ scope, mutation: { type: "rename", from: "a.md", to: "b.md" }, expectedDigest: before!.digest });
    expect(await store.read(scope, "a.md")).toBeNull();
    expect((await store.read(scope, "b.md"))?.content).toBe("x");

    const renamed = await store.read(scope, "b.md");
    await store.commit({ scope, mutation: { type: "delete", reference: "b.md" }, expectedDigest: renamed!.digest });
    expect(await store.inspect(scope)).toMatchObject({ documents: [] });
  });

  test("ignores non-reference files in the scope directory", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: null });
    const root = join(home, "memory", "projects", "a".repeat(64));
    await writeFile(join(root, "notes.txt"), "not memory");
    const snapshot = await store.inspect(scope);
    expect(snapshot.documents.map((d) => d.reference)).toEqual(["a.md"]);
  });

  test("rejects case-folding reference collisions", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: null });
    const root = join(home, "memory", "projects", "a".repeat(64));
    await writeFile(join(root, "Topic.md"), "collision");
    await expect(store.inspect(scope)).rejects.toMatchObject({ code: "MEMORY_REFERENCE_INVALID" });
  });

  test("rejects scope metadata for a different project key", async () => {
    const store = new FileMemoryStore({ home });
    await store.commit({ scope, mutation: { type: "create", reference: "a.md", content: "x" }, expectedDigest: null });
    const mismatched = { ...scope, projectKey: "other-project" };
    await expect(store.inspect(mismatched)).rejects.toMatchObject({ code: "MEMORY_SCOPE_MISMATCH" });
  });
});
