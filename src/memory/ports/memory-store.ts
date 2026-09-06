import type {
  MemoryDocument,
  MemoryDocumentReference,
  MemoryDocumentSummary,
  MemoryScopeSnapshot,
} from "../domain/memory-document";
import type { MemoryMutation } from "../domain/memory-mutation";
import type { MemoryScope } from "../domain/memory-scope";

/**
 * 管理权威 Memory Document 的存储 Port。Store 不接收 Model、Execution、
 * Session 或 Agent 对象，只处理 Scope 与 Mutation。
 */
export interface MemoryStore {
  inspect(scope: MemoryScope): Promise<MemoryScopeSnapshot>;
  list(scope: MemoryScope): Promise<MemoryDocumentSummary[]>;
  read(scope: MemoryScope, reference: MemoryDocumentReference): Promise<MemoryDocument | null>;
  commit(request: MemoryCommitRequest): Promise<MemoryCommitResult>;
}

export interface MemoryCommitRequest {
  scope: MemoryScope;
  mutation: MemoryMutation;
  expectedDigest?: string | null;
}

export interface MemoryCommitResult {
  committed: true;
  operation: MemoryMutation["type"];
  reference: MemoryDocumentReference;
  document?: MemoryDocument;
}
