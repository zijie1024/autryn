import path from "node:path";

import { z } from "zod";

import type { NonSystemMessage } from "@/core";

import { SessionError } from "./errors";
import type { SessionRecord } from "./session-types";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const textContentSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
const imageContentSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({
    url: z.string(),
    detail: z.enum(["auto", "high", "low"]).optional(),
  }),
});
const toolUseContentSchema = z
  .object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
  .passthrough();
const toolResultContentSchema = z
  .object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string() })
  .passthrough();

const userMessageSchema = z.object({
  role: z.literal("user"),
  content: z.array(z.union([textContentSchema, imageContentSchema])),
});

const assistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.union([textContentSchema, toolUseContentSchema])),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

const toolMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.array(toolResultContentSchema),
});

export const persistableMessageSchema = z.union([userMessageSchema, assistantMessageSchema, toolMessageSchema]);

const contextSourceRangeSchema = z.object({
  firstMessageIndex: z.number().int().nonnegative(),
  lastMessageIndex: z.number().int().nonnegative(),
  firstTurnIndex: z.number().int().nonnegative(),
  lastTurnIndex: z.number().int().nonnegative(),
  firstMessageId: z.string().optional(),
  lastMessageId: z.string().optional(),
  firstTurnId: z.string().optional(),
  lastTurnId: z.string().optional(),
  sourceRevision: z.number().int().positive().optional(),
});

const structuredContextSummarySchema = z.object({
  objectives: z.array(z.string()),
  constraints: z.array(z.string()),
  decisions: z.array(z.object({ decision: z.string(), reason: z.string().optional() })),
  progress: z.array(z.string()),
  results: z.array(z.string()),
  artifacts: z.array(z.string()),
  pending: z.array(z.string()),
});

const compactionNodeSchema = z.object({
  id: z.string().min(1),
  level: z.enum(["turn", "segment", "phase", "session"]),
  phaseId: z.string().optional(),
  checkpoint: z.boolean(),
  source: contextSourceRangeSchema,
  childNodeIds: z.array(z.string()),
  summary: structuredContextSummarySchema,
  renderedText: z.string(),
  estimatedTokens: z.number().int().nonnegative(),
  summarySchemaVersion: z.number().int().positive(),
  policyVersion: z.string().min(1),
  generatedBy: z.object({
    model: z.string().min(1),
    provider: z.string().optional(),
    configId: z.string().optional(),
    configName: z.string().optional(),
  }),
  generationUsage: z.object({
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    usageIncomplete: z.boolean().optional(),
  }),
  createdAt: z.string().datetime(),
});

const sessionCompactionStateSchema = z.object({
  version: z.literal(1),
  phases: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["active", "completed"]),
      objective: z.string(),
      startedTurnId: z.string(),
      endedTurnId: z.string().optional(),
      createdAt: z.string().datetime(),
      completedAt: z.string().datetime().optional(),
    }),
  ),
  nodes: z.array(compactionNodeSchema),
  checkpoint: z.object({
    sourceRevision: z.number().int().positive(),
    frontierNodeIds: z.array(z.string()),
    activePhaseId: z.string().nullable().optional(),
    nextPhaseObjective: z.string().nullable().optional(),
    policyVersion: z.string().min(1),
    summarySchemaVersion: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  }),
});

const executionModeSchema = z.enum(["execute", "dry_run"]);
const toolEffectSchema = z.object({
  kind: z.enum(["read", "ephemeral", "interaction", "control", "mutation", "unknown"]),
  scope: z.enum(["process", "workspace", "application", "system", "external"]),
  reversible: z.boolean().optional(),
  description: z.string(),
});
const toolPreviewSchema = z
  .object({
    status: z.enum(["planned", "no_change", "indeterminate"]),
    summary: z.string(),
    operations: z.array(
      z.object({
        action: z.string(),
        resource: z.object({ kind: z.string(), identifier: z.string() }),
        description: z.string(),
        before: z.unknown().optional(),
        after: z.unknown().optional(),
        reversible: z.boolean().optional(),
      }),
    ),
    warnings: z.array(z.string()),
    confidence: z.enum(["exact", "estimated", "unknown"]),
    fingerprint: z
      .object({
        algorithm: z.string(),
        value: z.string(),
        observedAt: z.string(),
      })
      .optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const dryRunReportSchema = z.object({
  runId: z.string(),
  rootExecutionId: z.string(),
  mode: z.literal("dry_run"),
  status: z.enum(["completed", "partial", "failed", "cancelled", "timed_out", "limit_exceeded"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  entries: z.array(
    z.object({
      executionId: z.string(),
      branchId: z.string(),
      agentId: z.string(),
      toolCallId: z.string(),
      toolName: z.string(),
      effect: toolEffectSchema,
      disposition: z.enum(["executed", "previewed", "blocked", "rejected"]),
      summary: z.string(),
      preview: toolPreviewSchema.optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
      timestamp: z.string().datetime(),
    }),
  ),
  summary: z.object({
    executedReads: z.number().int().nonnegative(),
    executedEphemeral: z.number().int().nonnegative(),
    interactions: z.number().int().nonnegative(),
    controlOperations: z.number().int().nonnegative(),
    previews: z.number().int().nonnegative(),
    noChanges: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    indeterminate: z.number().int().nonnegative(),
  }),
});
const handoffRecordSchema = z.object({
  sourceExecutionId: z.string(),
  successorExecutionId: z.string(),
  sourceAgentId: z.string(),
  targetAgentId: z.string(),
  sequence: z.number().int().positive(),
  committedAt: z.number(),
});

export const sessionRecordSchema = z.object({
  id: z.string().regex(uuidRegex),
  revision: z.number().int().positive(),
  name: z.string().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  workspace: z.object({
    cwd: z.string().min(1),
    projectKey: z.string().min(1),
  }),
  activeAgentId: z.string().min(1),
  activeAgentGroupId: z.string().min(1),
  agentModelOverrides: z.record(z.string(), z.string().regex(uuidRegex)),
  activeExecutionMode: executionModeSchema,
  messages: z.array(
    z.object({
      id: z.string().regex(uuidRegex),
      turnId: z.string().regex(uuidRegex),
      committedAt: z.string().datetime(),
      message: persistableMessageSchema,
    }),
  ),
  turns: z.array(
    z.object({
      id: z.string().regex(uuidRegex),
      status: z.enum(["running", "completed", "failed", "cancelled", "timed_out", "limit_exceeded", "interrupted"]),
      startedAt: z.string().datetime(),
      finishedAt: z.string().datetime().optional(),
      rootExecutionId: z.string().optional(),
      executionMode: executionModeSchema,
      initialAgentId: z.string().min(1),
      finalAgentId: z.string().min(1).optional(),
      handoffs: z.array(handoffRecordSchema),
      dryRunReport: dryRunReportSchema.optional(),
      agentGroupId: z.string().min(1),
      agentGroupRevision: z.string().regex(/^[0-9a-f]{64}$/),
      effectiveModels: z.array(
        z.object({
          executionId: z.string().min(1),
          agentId: z.string().min(1),
          configId: z.string().regex(uuidRegex),
          configName: z.string().min(1),
          provider: z.enum(["openai", "anthropic"]),
          model: z.string().min(1),
        }),
      ),
      usage: z
        .object({
          promptTokens: z.number().int().nonnegative(),
          completionTokens: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
          usageIncomplete: z.boolean().optional(),
        })
        .optional(),
      error: z
        .object({
          code: z.string().min(1),
          message: z.string().max(2000),
        })
        .optional(),
    }),
  ),
  compaction: sessionCompactionStateSchema,
});

export function parseSessionRecord(raw: unknown): SessionRecord {
  return sessionRecordSchema.parse(raw);
}

export function assertSessionRecord(record: SessionRecord): SessionRecord {
  return sessionRecordSchema.parse(record);
}

export function isCanonicalUuid(value: string): boolean {
  return uuidRegex.test(value);
}

export function normalizeSessionName(name: string): string {
  const normalized = name.trim().normalize("NFC");
  if (normalized.length === 0 || normalized.length > 80 || hasControlCharacter(normalized)) {
    throw new SessionError(
      "INVALID_SESSION_NAME",
      "Session name must be 1-80 characters and cannot contain control characters.",
    );
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

export function displaySessionName(record: { id: string; name: string | null }): string {
  return record.name ?? `Untitled · ${shortSessionId(record.id)}`;
}

export function projectKeyFromCwd(cwd: string, platform = process.platform): string {
  const resolved = path.resolve(cwd);
  return platform === "win32" ? resolved.toLocaleLowerCase() : resolved;
}

export function sanitizeMessageForPersistence(message: NonSystemMessage): NonSystemMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.filter((content) => content.type === "text" || content.type === "tool_use"),
      ...(message.usage ? { usage: { ...message.usage } } : {}),
    };
  }
  return structuredClone(message);
}
