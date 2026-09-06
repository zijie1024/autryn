import { MemoryError } from "./errors";
import { sha256Hex } from "./hashing";
import type { MemoryDocumentReference } from "./memory-document";

export type MemoryMutation =
  | { type: "create"; reference: MemoryDocumentReference; content: string }
  | {
      type: "replace";
      reference: MemoryDocumentReference;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
    }
  | {
      type: "insert";
      reference: MemoryDocumentReference;
      line: number;
      text: string;
    }
  | { type: "delete"; reference: MemoryDocumentReference }
  | {
      type: "rename";
      from: MemoryDocumentReference;
      to: MemoryDocumentReference;
    };

export interface ExistingDocument {
  reference: MemoryDocumentReference;
  content: string;
  digest: string;
}

/**
 * 一次 Mutation 规划后的确定结果：`afterContent === null` 表示删除，
 * `from` 仅在 rename 时出现。该纯函数同时服务 Store 的 commit 与 Service 的 preview，
 * 保证两者的校验与变换语义完全一致。
 */
export interface PlannedMutation {
  operation: MemoryMutation["type"];
  reference: MemoryDocumentReference;
  from?: MemoryDocumentReference;
  beforeDigest: string | null;
  afterContent: string | null;
  afterDigest: string | null;
  lineDelta: number;
  noChange: boolean;
}

export function planMutation(
  current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
  mutation: MemoryMutation,
): PlannedMutation {
  switch (mutation.type) {
    case "create": {
      if (current.has(mutation.reference)) {
        throw new MemoryError("MEMORY_ALREADY_EXISTS", `Memory document ${mutation.reference} already exists.`);
      }
      return {
        operation: "create",
        reference: mutation.reference,
        beforeDigest: null,
        afterContent: mutation.content,
        afterDigest: sha256Hex(mutation.content),
        lineDelta: lineCount(mutation.content),
        noChange: false,
      };
    }
    case "replace": {
      const existing = requireExisting(current, mutation.reference);
      const transformed = transformReplace(existing.content, mutation);
      return contentResult("replace", mutation.reference, existing, transformed);
    }
    case "insert": {
      const existing = requireExisting(current, mutation.reference);
      const transformed = transformInsert(existing.content, mutation);
      return contentResult("insert", mutation.reference, existing, transformed);
    }
    case "delete": {
      const existing = requireExisting(current, mutation.reference);
      return {
        operation: "delete",
        reference: mutation.reference,
        beforeDigest: existing.digest,
        afterContent: null,
        afterDigest: null,
        lineDelta: -lineCount(existing.content),
        noChange: false,
      };
    }
    case "rename": {
      const existing = requireExisting(current, mutation.from);
      if (current.has(mutation.to)) {
        throw new MemoryError("MEMORY_ALREADY_EXISTS", `Memory document ${mutation.to} already exists.`);
      }
      return {
        operation: "rename",
        reference: mutation.to,
        from: mutation.from,
        beforeDigest: existing.digest,
        afterContent: existing.content,
        afterDigest: existing.digest,
        lineDelta: 0,
        noChange: false,
      };
    }
  }
}

function contentResult(
  operation: "replace" | "insert",
  reference: MemoryDocumentReference,
  existing: ExistingDocument,
  transformed: { content: string; lineDelta: number; noChange: boolean },
): PlannedMutation {
  return {
    operation,
    reference,
    beforeDigest: existing.digest,
    afterContent: transformed.content,
    afterDigest: sha256Hex(transformed.content),
    lineDelta: transformed.lineDelta,
    noChange: transformed.noChange,
  };
}

function requireExisting(
  current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
  reference: MemoryDocumentReference,
): ExistingDocument {
  const existing = current.get(reference);
  if (!existing) {
    throw new MemoryError("MEMORY_NOT_FOUND", `Memory document ${reference} does not exist.`);
  }
  return existing;
}

function transformReplace(
  content: string,
  mutation: Extract<MemoryMutation, { type: "replace" }>,
): { content: string; lineDelta: number; noChange: boolean } {
  if (!content.includes(mutation.oldText)) {
    throw new MemoryError(
      "MEMORY_REVISION_CONFLICT",
      `The text to replace was not found in ${mutation.reference}.`,
      { retryable: true },
    );
  }
  if (!mutation.replaceAll && countOccurrences(content, mutation.oldText) > 1) {
    throw new MemoryError(
      "MEMORY_REVISION_CONFLICT",
      `The text to replace is not unique in ${mutation.reference}; set replaceAll to replace every occurrence.`,
      { retryable: true },
    );
  }
  const next = mutation.replaceAll
    ? content.split(mutation.oldText).join(mutation.newText)
    : content.replace(mutation.oldText, () => mutation.newText);
  return { content: next, lineDelta: lineCount(next) - lineCount(content), noChange: next === content };
}

function transformInsert(
  content: string,
  mutation: Extract<MemoryMutation, { type: "insert" }>,
): { content: string; lineDelta: number; noChange: boolean } {
  const lines = content.split("\n");
  if (mutation.line < 1 || mutation.line > lines.length + 1) {
    throw new MemoryError(
      "MEMORY_REFERENCE_INVALID",
      `Insert line ${mutation.line} is out of range (document has ${lines.length} lines).`,
    );
  }
  const next = [...lines.slice(0, mutation.line - 1), mutation.text, ...lines.slice(mutation.line - 1)].join("\n");
  return { content: next, lineDelta: lineCount(next) - lineCount(content), noChange: false };
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

function countOccurrences(content: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}
