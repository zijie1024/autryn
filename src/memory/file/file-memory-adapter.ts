import type { MemoryAdapter } from "../ports/memory-adapter";

import { FileMemoryStore, type FileMemoryStoreOptions } from "./file-memory-store";
import { IndexGuidedMemoryRetriever } from "./index-guided-memory-retriever";

export interface FileMemoryAdapterOptions extends FileMemoryStoreOptions {}

/**
 * 官方默认 Adapter：单一文件实现同时提供 Store 与索引引导检索，
 * Markdown 文件是唯一权威内容。
 */
export function createFileMemoryAdapter(options: FileMemoryStoreOptions): MemoryAdapter {
  const store = new FileMemoryStore(options);
  const retriever = new IndexGuidedMemoryRetriever(store);
  return { kind: "file", store, retriever };
}
