import { MEMORY_INDEX_REFERENCE } from "../defaults";
import type { MemoryDocumentReference, MemoryScope } from "../domain";
import type {
  MemoryHit,
  MemoryRetrievalRequest,
  MemoryRetrievalResult,
  MemoryRetriever,
} from "../ports/memory-retriever";
import type { MemoryStore } from "../ports/memory-store";

/**
 * 首版 Retriever：bootstrap 读取 `MEMORY.md`，reference 按 Agent 已选择的
 * Topic Reference 精确读取。不计算关键词或向量相关度，也不接受自然语言 Query。
 */
export class IndexGuidedMemoryRetriever implements MemoryRetriever {
  readonly kind = "index-guided";

  constructor(private readonly store: MemoryStore) {}

  async retrieve(request: MemoryRetrievalRequest): Promise<MemoryRetrievalResult> {
    if (request.mode === "bootstrap") {
      return this.retrieveBootstrap(request.scope, request.tokenBudget);
    }
    return this.retrieveReferences(request.scope, request.references);
  }

  private async retrieveBootstrap(scope: MemoryScope, tokenBudget: number): Promise<MemoryRetrievalResult> {
    const document = await this.store.read(scope, MEMORY_INDEX_REFERENCE);
    if (!document) {
      return { hits: [], estimatedTokens: 0, truncated: false };
    }
    const estimatedTokens = naiveTokenEstimate(document.content);
    return {
      hits: [{ source: "bootstrap", document }],
      estimatedTokens,
      truncated: estimatedTokens > tokenBudget,
    };
  }

  private async retrieveReferences(
    scope: MemoryScope,
    references: MemoryDocumentReference[],
  ): Promise<MemoryRetrievalResult> {
    const hits: MemoryHit[] = [];
    let estimatedTokens = 0;
    for (const reference of references) {
      const document = await this.store.read(scope, reference);
      if (!document) continue;
      estimatedTokens += naiveTokenEstimate(document.content);
      hits.push({ source: "reference", document });
    }
    return { hits, estimatedTokens, truncated: false };
  }
}

function naiveTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}
