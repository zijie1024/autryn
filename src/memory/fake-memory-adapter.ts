import { MemoryError, memoryScopeId } from "./domain";
import { sha256Hex } from "./domain";
import { planMutation, type ExistingDocument } from "./domain";
import type {
  MemoryDocument,
  MemoryDocumentReference,
  MemoryDocumentSummary,
  MemoryScopeSnapshot,
} from "./domain";
import type { MemoryMutation } from "./domain";
import type { MemoryScope } from "./domain";
import type { MemoryAdapter } from "./ports/memory-adapter";
import type { MemoryHit, MemoryRetrievalRequest, MemoryRetrievalResult, MemoryRetriever } from "./ports/memory-retriever";
import type { MemoryCommitRequest, MemoryCommitResult, MemoryStore } from "./ports/memory-store";

type StoredDocument = { content: string; digest: string; updatedAt: string };

/**
 * In-memory Adapter，用于 Library 消费与领域/Service 测试。
 * 与 FileMemoryStore 共享同一套 planMutation + digest 语义，但无文件、锁或路径约束。
 */
export function createFakeMemoryAdapter(
  initial: Record<string, Record<string, string>> = {},
): MemoryAdapter {
  const store = new FakeMemoryStore(initial);
  const retriever: MemoryRetriever = {
    kind: "fake",
    async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
      if (request.mode === "bootstrap") {
        const document = await store.read(request.scope, "MEMORY.md");
        if (!document) return { hits: [], estimatedTokens: 0, truncated: false };
        const estimatedTokens = Math.ceil(document.content.length / 4);
        return { hits: [{ source: "bootstrap", document }], estimatedTokens, truncated: estimatedTokens > request.tokenBudget };
      }
      const hits: MemoryHit[] = [];
      for (const reference of request.references) {
        const document = await store.read(request.scope, reference);
        if (document) hits.push({ source: "reference", document });
      }
      return { hits, estimatedTokens: 0, truncated: false };
    },
  };
  return { kind: "fake", store, retriever };
}

class FakeMemoryStore implements MemoryStore {
  private readonly scopes = new Map<string, Map<MemoryDocumentReference, StoredDocument>>();
  private readonly clock: () => string;

  constructor(initial: Record<string, Record<string, string>> = {}) {
    this.clock = () => new Date().toISOString();
    for (const [projectId, documents] of Object.entries(initial)) {
      const scopeDocs = new Map<MemoryDocumentReference, StoredDocument>();
      for (const [reference, content] of Object.entries(documents)) {
        scopeDocs.set(reference as MemoryDocumentReference, {
          content,
          digest: sha256Hex(content),
          updatedAt: this.clock(),
        });
      }
      this.scopes.set(projectId, scopeDocs);
    }
  }

  async inspect(scope: MemoryScope): Promise<MemoryScopeSnapshot> {
    const documents = this.scopeDocuments(scope, false);
    const summaries = [...documents.entries()].map(([reference, doc]) => toSummary(reference, doc));
    summaries.sort((a, b) => a.reference.localeCompare(b.reference));
    return {
      scope,
      materialized: this.scopes.has(memoryScopeId(scope)),
      documents: summaries,
      totalBytes: summaries.reduce((total, doc) => total + doc.sizeBytes, 0),
    };
  }

  async list(scope: MemoryScope): Promise<MemoryDocumentSummary[]> {
    return (await this.inspect(scope)).documents;
  }

  async read(scope: MemoryScope, reference: MemoryDocumentReference): Promise<MemoryDocument | null> {
    const doc = this.scopeDocuments(scope, false).get(reference);
    if (!doc) return null;
    return { scope, reference, content: doc.content, digest: doc.digest, sizeBytes: byteLength(doc.content), updatedAt: doc.updatedAt };
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    const { scope, mutation, expectedDigest } = request;
    const documents = this.scopeDocuments(scope, true);
    const current = new Map<MemoryDocumentReference, ExistingDocument>();
    for (const [reference, doc] of documents) {
      current.set(reference, { reference, content: doc.content, digest: doc.digest });
    }
    this.assertExpectedDigest(current, mutation, expectedDigest);
    const planned = planMutation(current, mutation);

    const before = mutation.type === "rename" ? documents.get(mutation.from) : documents.get(planned.reference);
    if (planned.operation === "create" && before) {
      throw new MemoryError("MEMORY_ALREADY_EXISTS", `Memory document ${planned.reference} already exists.`);
    }

    const now = this.clock();
    switch (planned.operation) {
      case "create":
      case "replace":
      case "insert":
        documents.set(planned.reference, { content: planned.afterContent!, digest: planned.afterDigest!, updatedAt: now });
        break;
      case "delete":
        documents.delete(planned.reference);
        break;
      case "rename":
        const moved = documents.get(planned.from!);
        documents.delete(planned.from!);
        documents.set(planned.reference, moved!);
        break;
    }
    this.scopes.set(memoryScopeId(scope), documents);

    const document =
      planned.afterContent !== null
        ? { scope, reference: planned.reference, content: planned.afterContent, digest: planned.afterDigest!, sizeBytes: byteLength(planned.afterContent), updatedAt: now }
        : undefined;
    return { committed: true, operation: planned.operation, reference: planned.reference, ...(document ? { document } : {}) };
  }

  private scopeDocuments(scope: MemoryScope, create: boolean): Map<MemoryDocumentReference, StoredDocument> {
    let documents = this.scopes.get(memoryScopeId(scope));
    if (!documents && create) {
      documents = new Map();
      this.scopes.set(memoryScopeId(scope), documents);
    }
    return documents ?? new Map();
  }

  private assertExpectedDigest(
    current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
    mutation: MemoryMutation,
    expectedDigest: string | null | undefined,
  ): void {
    if (expectedDigest === undefined) return;
    const reference = mutation.type === "rename" ? mutation.from : mutation.reference;
    const existing = current.get(reference);
    if (mutation.type === "create") {
      if (expectedDigest !== null) {
        throw new MemoryError("MEMORY_REVISION_CONFLICT", `Create of ${reference} must use a null expected digest.`, { retryable: true });
      }
      return;
    }
    if (expectedDigest === null) {
      throw new MemoryError("MEMORY_REVISION_CONFLICT", `Update of ${reference} requires the document's current digest.`, { retryable: true });
    }
    if (!existing || existing.digest !== expectedDigest) {
      throw new MemoryError("MEMORY_REVISION_CONFLICT", `Memory document ${reference} changed since it was read; re-read and retry.`, { retryable: true });
    }
  }
}

function toSummary(reference: MemoryDocumentReference, doc: StoredDocument): MemoryDocumentSummary {
  return { reference, digest: doc.digest, sizeBytes: byteLength(doc.content), updatedAt: doc.updatedAt };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
