import type { MemoryScope } from "./memory-scope";

export type MemoryDocumentReference = "MEMORY.md" | `${string}.md`;

export interface MemoryDocument {
  scope: MemoryScope;
  reference: MemoryDocumentReference;
  content: string;
  digest: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface MemoryDocumentSummary {
  reference: MemoryDocumentReference;
  digest: string;
  sizeBytes: number;
  updatedAt: string;
}

export interface MemoryScopeSnapshot {
  scope: MemoryScope;
  materialized: boolean;
  documents: MemoryDocumentSummary[];
  totalBytes: number;
}
