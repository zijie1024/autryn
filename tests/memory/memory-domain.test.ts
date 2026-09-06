import { describe, expect, test } from "bun:test";

import { MemoryError } from "@/memory";
import {
  planMutation,
  projectIdFromProjectKey,
  projectMemoryScope,
  type ExistingDocument,
  type MemoryDocumentReference,
} from "@/memory";
import { parseReference } from "@/memory/file/file-memory-paths";

describe("projectIdFromProjectKey", () => {
  test("produces a stable 64-char lowercase hex id", () => {
    const id = projectIdFromProjectKey("/workspace/demo");
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(projectIdFromProjectKey("/workspace/demo")).toBe(id);
  });

  test("distinguishes different project keys", () => {
    expect(projectIdFromProjectKey("/a")).not.toBe(projectIdFromProjectKey("/b"));
  });

  test("prefix isolates the algorithm from other id schemes", () => {
    expect(projectIdFromProjectKey("key")).not.toBe(projectIdFromProjectKey("other"));
  });
});

describe("projectMemoryScope", () => {
  test("derives projectId from projectKey", () => {
    const scope = projectMemoryScope("k", "/cwd");
    expect(scope.kind).toBe("project");
    expect(scope.projectId).toBe(projectIdFromProjectKey("k"));
    expect(scope.projectKey).toBe("k");
    expect(scope.cwd).toBe("/cwd");
  });
});

describe("parseReference", () => {
  test("accepts the index and lowercase kebab-case topics", () => {
    expect(parseReference("MEMORY.md")).toBe("MEMORY.md");
    expect(parseReference("architecture.md")).toBe("architecture.md");
    expect(parseReference("debugging-notes.md")).toBe("debugging-notes.md");
  });

  test("rejects invalid references", () => {
    for (const invalid of [
      "",
      "MEMORY",
      "memory.md",
      "Foo.md",
      "foo_bar.md",
      "foo bar.md",
      ".hidden.md",
      "scope.json",
      "../evil.md",
      "foo/bar.md",
      "/abs.md",
      "foo.md\n",
      "a.md\0",
    ]) {
      expect(() => parseReference(invalid)).toThrow(MemoryError);
    }
  });
});

function existing(reference: MemoryDocumentReference, content: string): [MemoryDocumentReference, ExistingDocument] {
  return [reference, { reference, content, digest: "d-" + reference }];
}

describe("planMutation", () => {
  test("create refuses to overwrite an existing document", () => {
    const current = new Map([existing("foo.md", "hello")]);
    expect(() => planMutation(current, { type: "create", reference: "foo.md", content: "x" })).toThrow(
      /already exists/,
    );
  });

  test("create computes a digest and line count", () => {
    const planned = planMutation(new Map(), { type: "create", reference: "foo.md", content: "a\nb" });
    expect(planned.operation).toBe("create");
    expect(planned.beforeDigest).toBeNull();
    expect(planned.afterContent).toBe("a\nb");
    expect(planned.lineDelta).toBe(2);
  });

  test("replace requires a unique match unless replaceAll", () => {
    const current = new Map([existing("foo.md", "x x")]);
    expect(() => planMutation(current, { type: "replace", reference: "foo.md", oldText: "x", newText: "y" })).toThrow(
      /not unique/,
    );
    const planned = planMutation(current, {
      type: "replace",
      reference: "foo.md",
      oldText: "x",
      newText: "y",
      replaceAll: true,
    });
    expect(planned.afterContent).toBe("y y");
  });

  test("replace reports a conflict when the needle is missing", () => {
    const current = new Map([existing("foo.md", "hello")]);
    expect(() => planMutation(current, { type: "replace", reference: "foo.md", oldText: "zzz", newText: "y" })).toThrow(
      /not found/,
    );
  });

  test("insert validates 1-based line range", () => {
    const current = new Map([existing("foo.md", "a\nb")]);
    expect(() => planMutation(current, { type: "insert", reference: "foo.md", line: 4, text: "x" })).toThrow(
      /out of range/,
    );
    const planned = planMutation(current, { type: "insert", reference: "foo.md", line: 1, text: "x" });
    expect(planned.afterContent).toBe("x\na\nb");
  });

  test("rename refuses when the target already exists", () => {
    const current = new Map([existing("foo.md", "a"), existing("bar.md", "b")]);
    expect(() => planMutation(current, { type: "rename", from: "foo.md", to: "bar.md" })).toThrow(/already exists/);
  });
});
