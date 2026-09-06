import type { MemoryDocument, MemoryDocumentReference } from "../domain/memory-document";
import type { MemoryScope } from "../domain/memory-scope";

export type MemoryRetrievalRequest =
  | {
      mode: "bootstrap";
      scope: MemoryScope;
      tokenBudget: number;
    }
  | {
      mode: "reference";
      scope: MemoryScope;
      references: MemoryDocumentReference[];
    };

export interface MemoryRetriever {
  readonly kind: string;
  retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult>;
}

export interface MemoryRetrievalResult {
  hits: MemoryHit[];
  estimatedTokens: number;
  truncated: boolean;
}

export interface MemoryHit {
  source: "bootstrap" | "reference";
  document: MemoryDocument;
}
