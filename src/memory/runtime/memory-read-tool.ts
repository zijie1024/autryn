import { z } from "zod";

import { defineTool, type Tool } from "@/core";

import { memoryScopeId, shortDigest } from "../domain";
import type { MemoryPolicy, MemoryScope } from "../domain";
import type { MemoryService } from "../memory-service";

import { emitMemoryEvent, type MemoryObserver } from "./memory-events";
import { memoryReferenceSchema } from "./memory-schemas";
import { memoryErrorResult, okToolResult } from "./memory-tool-utils";

const memoryReadParameters = z.discriminatedUnion("command", [
  z.object({ command: z.literal("list") }),
  z.object({ command: z.literal("view"), reference: memoryReferenceSchema }),
]);

export function createMemoryReadTool(
  service: MemoryService,
  scope: MemoryScope,
  policy: MemoryPolicy,
  observer?: MemoryObserver,
): Tool {
  return defineTool({
    name: "memory_read",
    description:
      "Read durable memory in this authorized scope. Use `list` to see documents with their digest, or `view` to read one document's full content.",
    parameters: memoryReadParameters,
    effect: { kind: "read", scope: "application", description: "Reads memory documents without modifying them." },
    execute: async (input, context) => {
      try {
        if (input.command === "list") {
          const snapshot = await service.inspect(scope, policy);
          return okToolResult(`Listed ${snapshot.documents.length} memory document(s).`, {
            scope: { kind: scope.kind, scopeId: memoryScopeId(scope) },
            materialized: snapshot.materialized,
            documents: snapshot.documents.map((document) => ({
              reference: document.reference,
              digest: shortDigest(document.digest),
              sizeBytes: document.sizeBytes,
              updatedAt: document.updatedAt,
            })),
            totalBytes: snapshot.totalBytes,
          });
        }
        const document = await service.view(scope, policy, input.reference);
        emitMemoryEvent(observer, {
          type: "memory",
          adapterKind: service.adapter.kind,
          scope: scope.kind,
          scopeId: memoryScopeId(scope),
          ...executionIdentity(context.execution),
          timestamp: new Date().toISOString(),
          status: "recalled",
          reference: document.reference,
        });
        return okToolResult(`Read ${document.reference} (${document.sizeBytes} bytes).`, {
          scope: { kind: scope.kind, scopeId: memoryScopeId(scope) },
          reference: document.reference,
          content: document.content,
          digest: document.digest,
          sizeBytes: document.sizeBytes,
          updatedAt: document.updatedAt,
        });
      } catch (error) {
        return memoryErrorResult(error, "MEMORY_READ_FAILED");
      }
    },
  });
}

function executionIdentity(execution: unknown): { executionId?: string; agentId?: string } {
  if (!execution || typeof execution !== "object") return {};
  const value = execution as { id?: unknown; agentId?: unknown };
  return {
    ...(typeof value.id === "string" ? { executionId: value.id } : {}),
    ...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
  };
}
