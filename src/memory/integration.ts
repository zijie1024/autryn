import { z } from "zod";

import { defineTool, type Tool, type ToolExecutionContext, type ToolPreviewContext } from "@/core";
import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import { MemoryError, shortDigest } from "./domain";
import {
  isGlobalMemoryScope,
  isProjectMemoryScope,
  type LayeredMemoryPolicy,
  type MemoryLayerBinding,
  type MemoryLayerName,
  type MemoryScope,
} from "./domain";
import type { MemoryService } from "./memory-service";
import { emitMemoryEvent, type MemoryObserver } from "./runtime/memory-events";
import { createMemoryReadTool } from "./runtime/memory-read-tool";
import { memoryReferenceSchema } from "./runtime/memory-schemas";
import { createMemoryWriteTool, memoryWriteParameters } from "./runtime/memory-write-tool";

export interface MemoryIntegration {
  readonly adapterKind: string;
  readonly layers: readonly MemoryLayerBinding[];
  readonly middleware?: AgentMiddleware;
  readonly tools: Tool[];
}

export interface CodingMemoryRuntime {
  readonly service: MemoryService;
  readonly globalScope: MemoryScope & { kind: "global" };
  readonly projectScope: MemoryScope & { kind: "project" };
  createIntegration(policy: LayeredMemoryPolicy): MemoryIntegration;
}

export function createMemoryIntegration(options: {
  service: MemoryService;
  policy: LayeredMemoryPolicy;
  observer?: MemoryObserver;
}): MemoryIntegration {
  const { service, observer } = options;
  const layers = validateAndOrderLayers(options.policy);
  const readable = layers.filter((layer) => layer.policy.access !== "none");
  const writable = layers.filter(
    (layer) => layer.policy.access === "read_write" && layer.policy.autoWrite,
  );
  const tools: Tool[] = [];
  if (readable.length > 0) tools.push(createLayeredReadTool(service, readable, observer));
  if (writable.length > 0) tools.push(createLayeredWriteTool(service, writable, observer));
  const middleware = readable.length > 0
    ? createLayeredMemoryMiddleware(service, readable, options.policy.totalBootstrapTokens, observer)
    : undefined;
  return {
    adapterKind: service.adapter.kind,
    layers,
    ...(middleware ? { middleware } : {}),
    tools,
  };
}

function validateAndOrderLayers(policy: LayeredMemoryPolicy): readonly MemoryLayerBinding[] {
  if (!Number.isInteger(policy.totalBootstrapTokens) || policy.totalBootstrapTokens <= 0) {
    throw new MemoryError("MEMORY_POLICY_INVALID", "Memory total bootstrap budget must be a positive integer.");
  }
  if (policy.layers.length === 0) {
    throw new MemoryError("MEMORY_POLICY_INVALID", "Memory integration requires at least one layer.");
  }
  const names = new Set<MemoryLayerName>();
  const scopeIds = new Set<string>();
  const priorities = new Set<number>();
  for (const layer of policy.layers) {
    if (layer.name !== layer.scope.kind) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} has a mismatched scope.`);
    }
    if (!isGlobalMemoryScope(layer.scope) && !isProjectMemoryScope(layer.scope)) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} has an invalid scope.`);
    }
    if (names.has(layer.name) || scopeIds.has(`${layer.scope.kind}:${layer.scope.scopeId}`)) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} is duplicated.`);
    }
    if (!Number.isFinite(layer.priority) || priorities.has(layer.priority)) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} has an invalid priority.`);
    }
    if (!Number.isInteger(layer.policy.limits.bootstrapTokens) || layer.policy.limits.bootstrapTokens <= 0) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} has an invalid bootstrap budget.`);
    }
    if (!["none", "read", "read_write"].includes(layer.policy.access)) {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} has an invalid access policy.`);
    }
    if (layer.policy.autoWrite && layer.policy.access !== "read_write") {
      throw new MemoryError("MEMORY_POLICY_INVALID", `Memory layer ${layer.name} enables auto-write without read-write access.`);
    }
    names.add(layer.name);
    scopeIds.add(`${layer.scope.kind}:${layer.scope.scopeId}`);
    priorities.add(layer.priority);
  }
  const readableBudget = policy.layers
    .filter((layer) => layer.policy.access !== "none")
    .reduce((total, layer) => total + layer.policy.limits.bootstrapTokens, 0);
  if (readableBudget > policy.totalBootstrapTokens) {
    throw new MemoryError(
      "MEMORY_POLICY_INVALID",
      "Memory layer bootstrap budgets exceed the combined bootstrap budget.",
    );
  }
  return [...policy.layers].sort((left, right) => {
    if (left.name === "global" && right.name === "project") return -1;
    if (left.name === "project" && right.name === "global") return 1;
    return left.priority - right.priority;
  });
}

function createLayeredMemoryMiddleware(
  service: MemoryService,
  layers: readonly MemoryLayerBinding[],
  totalBootstrapTokens: number,
  observer?: MemoryObserver,
): AgentMiddleware {
  return {
    name: "memory",
    dryRun: { mode: "compatible" },
    beforeModel: async ({ modelContext }) => {
      const blocks: string[] = [];
      let estimatedTokens = 0;
      for (const layer of layers) {
        try {
          const bootstrap = await service.bootstrap(layer.scope, layer.policy);
          if (!bootstrap.text) continue;
          blocks.push(bootstrap.text);
          estimatedTokens += bootstrap.estimatedTokens;
          emitMemoryEvent(observer, {
            type: "memory",
            adapterKind: service.adapter.kind,
            scope: layer.name,
            scopeId: layer.scope.scopeId,
            timestamp: new Date().toISOString(),
            status: "bootstrap_loaded",
            documentCount: bootstrap.documentCount,
          });
        } catch (error) {
          if (layer.policy.failureMode === "required") throw error;
          emitMemoryEvent(observer, {
            type: "memory",
            adapterKind: service.adapter.kind,
            scope: layer.name,
            scopeId: layer.scope.scopeId,
            timestamp: new Date().toISOString(),
            status: "warning",
            code: memoryErrorCode(error),
          });
        }
      }
      if (estimatedTokens > totalBootstrapTokens) {
        throw new MemoryError(
          "MEMORY_BOOTSTRAP_TOO_LARGE",
          `Combined memory bootstrap exceeds the ${totalBootstrapTokens} token budget.`,
        );
      }
      return blocks.length > 0 ? { prompt: `${modelContext.prompt}\n\n${blocks.join("\n\n")}` } : null;
    },
  };
}

function createLayeredReadTool(
  service: MemoryService,
  layers: readonly MemoryLayerBinding[],
  observer?: MemoryObserver,
): Tool {
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]));
  const names = layers.map((layer) => layer.name) as [MemoryLayerName, ...MemoryLayerName[]];
  const listNames = (layers.length > 1 ? [...names, "all"] : names) as [
    MemoryLayerName | "all",
    ...(MemoryLayerName | "all")[],
  ];
  const parameters = z
    .object({
      command: z.enum(["list", "view"]),
      scope: z.enum(listNames),
      reference: memoryReferenceSchema.optional(),
    })
    .refine((input) => input.command !== "view" || input.scope !== "all", {
      message: "The view command requires a concrete memory scope.",
      path: ["scope"],
    })
    .refine((input) => input.command !== "view" || input.reference !== undefined, {
      message: "A memory reference is required for the view command.",
      path: ["reference"],
    });
  return defineTool({
    name: "memory_read",
    description: "Read durable memory from an explicitly selected global or project scope.",
    parameters,
    effect: { kind: "read", scope: "application", description: "Reads memory documents without modifying them." },
    execute: async (input, context) => {
      if (input.command === "list" && input.scope === "all") {
        const groups = await Promise.all(layers.map(async (layer) => {
          const snapshot = await service.inspect(layer.scope, layer.policy);
          return {
            scope: layer.name,
            scopeId: layer.scope.scopeId,
            materialized: snapshot.materialized,
            documents: snapshot.documents.map((document) => ({
              reference: document.reference,
              digest: shortDigest(document.digest),
              sizeBytes: document.sizeBytes,
              updatedAt: document.updatedAt,
            })),
            totalBytes: snapshot.totalBytes,
          };
        }));
        return { ok: true, summary: `Listed ${groups.length} memory scopes.`, data: { scopes: groups } };
      }
      if (input.command === "view" && (!input.reference || input.scope === "all")) {
        return memoryScopeError(input.scope);
      }
      const layer = layerByName.get(input.scope as MemoryLayerName);
      if (!layer) return memoryScopeError(input.scope);
      const tool = createMemoryReadTool(service, layer.scope, layer.policy, observer);
      const inner = input.command === "list"
        ? { command: "list" as const }
        : { command: "view" as const, reference: input.reference };
      return tool.execute(inner, context as ToolExecutionContext);
    },
  });
}

function createLayeredWriteTool(
  service: MemoryService,
  layers: readonly MemoryLayerBinding[],
  observer?: MemoryObserver,
): Tool {
  const layerByName = new Map(layers.map((layer) => [layer.name, layer]));
  const names = layers.map((layer) => layer.name) as [MemoryLayerName, ...MemoryLayerName[]];
  const parameters = memoryWriteParameters.extend({ scope: z.enum(names) });
  return defineTool({
    name: "memory_write",
    description: "Create, update, rename, or delete durable memory in an explicitly selected global or project scope.",
    parameters,
    effect: { kind: "mutation", scope: "application", description: "Modifies memory documents." },
    execute: async (input, context) => {
      const layer = layerByName.get(input.scope);
      if (!layer) return memoryScopeError(input.scope);
      return createMemoryWriteTool(service, layer.scope, layer.policy, observer).execute(
        { mutation: input.mutation, expectedDigest: input.expectedDigest },
        context as ToolExecutionContext,
      );
    },
    preview: async (input, context) => {
      const layer = layerByName.get(input.scope);
      if (!layer) return indeterminateScopePreview(input.scope);
      const preview = createMemoryWriteTool(service, layer.scope, layer.policy, observer).preview;
      if (!preview) return indeterminateScopePreview(input.scope);
      return preview(
        { mutation: input.mutation, expectedDigest: input.expectedDigest },
        context as ToolPreviewContext,
      );
    },
  });
}

function memoryScopeError(scope: string) {
  return {
    ok: false,
    summary: `Memory scope ${scope} is not authorized.`,
    error: "Memory scope is not authorized.",
    code: "MEMORY_ACCESS_DENIED",
  };
}

function indeterminateScopePreview(scope: string) {
  return {
    status: "indeterminate" as const,
    summary: `Memory scope ${scope} is not authorized.`,
    operations: [],
    warnings: ["MEMORY_ACCESS_DENIED"],
    confidence: "unknown" as const,
  };
}

function memoryErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as Error & { code: unknown }).code)
    : "MEMORY_READ_FAILED";
}
