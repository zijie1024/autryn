import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import { memoryScopeId } from "../domain";
import type { MemoryPolicy, MemoryScope } from "../domain";
import type { MemoryService } from "../memory-service";

import { emitMemoryEvent, type MemoryObserver } from "./memory-events";

/**
 * 在每次 Model 调用前把 `MEMORY.md` 的 Bootstrap 追加到 prompt，
 * 不修改 Agent 原始 prompt、不追加 User Message、也不写入 Session canonical transcript。
 * dry-run 下只读 Bootstrap，标记为 compatible。
 */
export function createMemoryMiddleware(
  service: MemoryService,
  scope: MemoryScope,
  policy: MemoryPolicy,
  observer?: MemoryObserver,
): AgentMiddleware {
  return {
    name: "memory",
    dryRun: { mode: "compatible" },
    beforeModel: async ({ modelContext }) => {
      try {
        const bootstrap = await service.bootstrap(scope, policy);
        if (!bootstrap.text) return null;
        emitMemoryEvent(observer, {
          type: "memory",
          adapterKind: service.adapter.kind,
          scope: scope.kind,
          scopeId: memoryScopeId(scope),
          timestamp: new Date().toISOString(),
          status: "bootstrap_loaded",
          documentCount: bootstrap.documentCount,
        });
        return { prompt: modelContext.prompt + "\n\n" + bootstrap.text };
      } catch (error) {
        if (policy.failureMode === "required") throw error;
        emitMemoryEvent(observer, {
          type: "memory",
          adapterKind: service.adapter.kind,
          scope: scope.kind,
          scopeId: memoryScopeId(scope),
          timestamp: new Date().toISOString(),
          status: "warning",
          code: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "MEMORY_READ_FAILED",
        });
        return null;
      }
    },
  };
}
