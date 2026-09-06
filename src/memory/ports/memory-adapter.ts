import type { MemoryRetriever } from "./memory-retriever";
import type { MemoryStore } from "./memory-store";

export interface MemoryAdapter {
  readonly kind: string;
  readonly store: MemoryStore;
  readonly retriever: MemoryRetriever;
}
