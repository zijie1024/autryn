export type MemoryAccess = "none" | "read" | "read_write";

export interface MemoryLimits {
  bootstrapTokens: number;
  maxDocumentBytes: number;
  maxDocumentsPerScope: number;
  maxScopeBytes: number;
}

export interface MemoryPolicy {
  access: MemoryAccess;
  autoWrite: boolean;
  limits: MemoryLimits;
  failureMode: "required" | "best_effort";
}

export type MemoryLayerName = "global" | "project";

export interface MemoryLayerBinding {
  name: MemoryLayerName;
  scope: MemoryScope;
  policy: MemoryPolicy;
  priority: number;
}

export interface LayeredMemoryPolicy {
  totalBootstrapTokens: number;
  layers: readonly MemoryLayerBinding[];
}
import type { MemoryScope } from "./memory-scope";
