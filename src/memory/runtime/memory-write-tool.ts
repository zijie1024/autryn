import { z } from "zod";

import { defineTool, type Tool } from "@/core";

import { memoryScopeId } from "../domain";
import type { MemoryPolicy, MemoryScope } from "../domain";
import type { MemoryService } from "../memory-service";

import { emitMemoryEvent, type MemoryObserver } from "./memory-events";
import { memoryReferenceSchema } from "./memory-schemas";
import { memoryErrorCode, memoryErrorResult, okToolResult } from "./memory-tool-utils";

export const memoryWriteParameters = z.object({
  mutation: z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), reference: memoryReferenceSchema, content: z.string() }),
    z.object({
      type: z.literal("replace"),
      reference: memoryReferenceSchema,
      oldText: z.string(),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    z.object({ type: z.literal("insert"), reference: memoryReferenceSchema, line: z.number().int().positive(), text: z.string() }),
    z.object({ type: z.literal("delete"), reference: memoryReferenceSchema }),
    z.object({ type: z.literal("rename"), from: memoryReferenceSchema, to: memoryReferenceSchema }),
  ]),
  expectedDigest: z.string().nullable(),
});

export function createMemoryWriteTool(
  service: MemoryService,
  scope: MemoryScope,
  policy: MemoryPolicy,
  observer?: MemoryObserver,
): Tool {
  return defineTool({
    name: "memory_write",
    description:
      "Create, edit, rename, or delete a durable memory document in this authorized scope. `expectedDigest` is null for create and the current digest for every other operation; a digest mismatch reports a conflict so you can re-read and retry. Save only durable, verified, reusable facts; merge duplicates and update stale facts instead of appending. Never store credentials, transient todo state, full session logs, or large source code.",
    parameters: memoryWriteParameters,
    effect: {
      kind: "mutation",
      scope: "application",
      description: "Modifies memory documents in the authorized scope.",
    },
    execute: async (input, context) => {
      try {
        const result = await service.commitMutation(scope, policy, input.mutation, input.expectedDigest);
        emitMemoryEvent(observer, {
          ...eventBase(service.adapter.kind, scope, context.execution),
          status: "committed",
          reference: result.reference,
          operation: result.operation,
        });
        return okToolResult(`${result.operation} ${result.reference}`, {
          scope: { kind: scope.kind, scopeId: memoryScopeId(scope) },
          operation: result.operation,
          reference: result.reference,
          digest: result.document?.digest ?? null,
        });
      } catch (error) {
        if (memoryErrorCode(error, "") === "MEMORY_REVISION_CONFLICT") {
          const reference = input.mutation.type === "rename" ? input.mutation.from : input.mutation.reference;
          emitMemoryEvent(observer, {
            ...eventBase(service.adapter.kind, scope, context.execution),
            status: "conflict",
            reference,
          });
        }
        return memoryErrorResult(error, "MEMORY_WRITE_FAILED");
      }
    },
    preview: async (input, context) => {
      try {
        const preview = await service.previewMutation(scope, policy, input.mutation, input.expectedDigest);
        emitMemoryEvent(observer, {
          ...eventBase(service.adapter.kind, scope, context.execution),
          status: "previewed",
          reference: preview.reference,
          operation: preview.operation,
        });
        return {
          status: preview.noChange ? "no_change" : "planned",
          summary: `${preview.operation} ${preview.reference} (${preview.lineDelta > 0 ? "+" : ""}${preview.lineDelta} lines)`,
          operations: [
            {
              action: preview.operation,
              resource: { kind: "memory-document", identifier: `${scope.kind}:${preview.reference}` },
              description: preview.diff,
              ...(preview.beforeDigest ? { before: { digest: preview.beforeDigest } } : {}),
              ...(preview.afterDigest ? { after: { digest: preview.afterDigest } } : {}),
            },
          ],
          warnings: [],
          confidence: "exact",
          details: { scope: { kind: scope.kind, scopeId: memoryScopeId(scope) } },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "indeterminate",
          summary: message,
          operations: [],
          warnings: [`${memoryErrorCode(error, "MEMORY_PREVIEW_FAILED")}: ${message}`],
          confidence: "unknown",
        };
      }
    },
  });
}

function eventBase(adapterKind: string, scope: MemoryScope, execution: unknown) {
  const identity = execution && typeof execution === "object"
    ? execution as { id?: unknown; agentId?: unknown }
    : {};
  return {
    type: "memory" as const,
    adapterKind,
    scope: scope.kind,
    scopeId: memoryScopeId(scope),
    ...(typeof identity.id === "string" ? { executionId: identity.id } : {}),
    ...(typeof identity.agentId === "string" ? { agentId: identity.agentId } : {}),
    timestamp: new Date().toISOString(),
  };
}
