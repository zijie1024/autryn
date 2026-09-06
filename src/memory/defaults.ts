import type { MemoryDocumentReference } from "./domain/memory-document";
import type { MemoryLimits } from "./domain/memory-policy";

export const MEMORY_INDEX_REFERENCE = "MEMORY.md" as const;

export function isIndexReference(reference: MemoryDocumentReference): boolean {
  return reference === MEMORY_INDEX_REFERENCE;
}

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
  bootstrapTokens: 1_200,
  maxDocumentBytes: 64 * 1024,
  maxDocumentsPerScope: 64,
  maxScopeBytes: 2 * 1024 * 1024,
};
