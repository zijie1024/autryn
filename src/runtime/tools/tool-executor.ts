import type { z } from "zod";

import {
  type RuntimeToolOutcome,
  type StructuredToolError,
  type Tool,
  type ToolDisposition,
  type ToolPreview,
  toRuntimeToolOutcome,
} from "@/core";
import type { AgentContext } from "@/runtime/agent/agent";
import { executionError, type AgentExecution } from "@/runtime/execution/agent-execution";
import type { DryRunEntry, ToolExecutionRecord } from "@/runtime/execution/types";
import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

export interface ToolInvocation {
  id: string;
  tool: Tool;
  toolName: string;
  input: Record<string, unknown>;
  mode: "execute" | "dry_run";
  execution: AgentExecution;
}

export interface ToolExecutorOptions {
  middlewares: readonly AgentMiddleware[];
  agentContext: AgentContext;
  recordDryRunEntry?: (entry: DryRunEntry) => void;
}

export class ToolExecutor {
  constructor(private readonly options: ToolExecutorOptions) {}

  async invoke(invocation: ToolInvocation): Promise<ToolExecutionRecord> {
    const { execution, tool } = invocation;
    execution.emitToolEvent({
      type: "tool",
      status: "started",
      mode: invocation.mode,
      effect: tool.effect,
      toolCallId: invocation.id,
      toolName: invocation.toolName,
    });

    const before = await this.beforeToolUse(invocation);
    if (before.action === "reject") {
      const outcome = blockedOutcome(invocation.mode, before.result.code ?? "TOOL_USE_DENIED", before.result.error);
      return this.finish(invocation, "rejected", outcome);
    }
    if (before.input) invocation.input = before.input;

    const routed = await this.route(invocation);
    await this.afterToolUse(invocation, routed.disposition, routed.outcome);
    return this.finish(invocation, routed.disposition, routed.outcome);
  }

  private async route(invocation: ToolInvocation): Promise<{ disposition: ToolDisposition; outcome: RuntimeToolOutcome }> {
    const { tool, mode } = invocation;
    if (mode === "execute") {
      const result = await tool.execute(invocation.input as never, {
        mode,
        signal: invocation.execution.signal,
        execution: invocation.execution.getSnapshot(),
        toolCallId: invocation.id,
      });
      return {
        disposition: "executed",
        outcome: toRuntimeToolOutcome(result, "executed", mode, `Executed ${tool.name}.`),
      };
    }

    if (tool.effect.kind === "read" || tool.effect.kind === "ephemeral" || tool.effect.kind === "interaction" || tool.effect.kind === "control") {
      const result = await tool.execute(invocation.input as never, {
        mode,
        signal: invocation.execution.signal,
        execution: invocation.execution.getSnapshot(),
        toolCallId: invocation.id,
      });
      return {
        disposition: "executed",
        outcome: toRuntimeToolOutcome(result, "executed", mode, `Executed ${tool.name} in dry-run.`),
      };
    }

    if (tool.effect.kind === "mutation") {
      if (!tool.preview) {
        return {
          disposition: "blocked",
          outcome: blockedOutcome(mode, "DRY_RUN_PREVIEW_UNAVAILABLE", "This tool does not provide a dry-run preview."),
        };
      }
      try {
        const preview = sanitizePreview(
          await tool.preview(invocation.input as never, {
            mode: "dry_run",
            signal: invocation.execution.signal,
            execution: invocation.execution.getSnapshot(),
            toolCallId: invocation.id,
          }),
        );
        return {
          disposition: "previewed",
          outcome: { ok: true, disposition: "previewed", mode, summary: preview.summary, preview },
        };
      } catch (error) {
        const invalid = error instanceof PreviewValidationError;
        const message = scrubText(error instanceof Error ? error.message : String(error));
        return {
          disposition: "blocked",
          outcome: blockedOutcome(mode, invalid ? "DRY_RUN_PREVIEW_INVALID" : "DRY_RUN_PREVIEW_FAILED", message),
        };
      }
    }

    return {
      disposition: "blocked",
      outcome: blockedOutcome(mode, "DRY_RUN_UNKNOWN_EFFECT", "Tool effect is unknown in dry-run mode."),
    };
  }

  private async beforeToolUse(invocation: ToolInvocation): Promise<{ action: "continue"; input?: Record<string, unknown> } | { action: "reject"; result: StructuredToolError }> {
    for (const middleware of this.options.middlewares) {
      if (shouldSkipMiddlewareForDryRun(middleware, invocation.mode)) continue;
      if (!middleware.beforeToolUse) continue;
      const result = await middleware.beforeToolUse({
        agentContext: this.options.agentContext,
        invocation,
        signal: invocation.execution.signal,
      });
      if (!result) continue;
      if ("action" in result && result.action === "reject") return result;
      if ("action" in result && result.input) {
        const parsed = (invocation.tool.parameters as z.ZodSchema<Record<string, unknown>>).safeParse(result.input);
        if (!parsed.success) {
          return {
            action: "reject",
            result: {
              ok: false,
              summary: `Invalid middleware input for tool ${invocation.toolName}.`,
              error: `Invalid middleware input for tool ${invocation.toolName}.`,
              code: "INVALID_TOOL_INPUT",
            },
          };
        }
        return { action: "continue", input: parsed.data };
      }
      if ("prompt" in result || "messages" in result || "tools" in result || "skills" in result) {
        Object.assign(this.options.agentContext, result);
      }
    }
    return { action: "continue" };
  }

  private async afterToolUse(invocation: ToolInvocation, disposition: ToolDisposition, result: RuntimeToolOutcome) {
    for (const middleware of this.options.middlewares) {
      if (shouldSkipMiddlewareForDryRun(middleware, invocation.mode)) continue;
      if (!middleware.afterToolUse) continue;
      const next = await middleware.afterToolUse({
        agentContext: this.options.agentContext,
        invocation,
        disposition,
        result,
      });
      if (next) Object.assign(this.options.agentContext, next);
    }
  }

  private finish(invocation: ToolInvocation, disposition: ToolDisposition, outcome: RuntimeToolOutcome): ToolExecutionRecord {
    const status = disposition === "previewed" ? "previewed" : disposition === "executed" ? "executed" : disposition === "rejected" ? "rejected" : "blocked";
    invocation.execution.emitToolEvent({
      type: "tool",
      status,
      mode: invocation.mode,
      effect: invocation.tool.effect,
      toolCallId: invocation.id,
      toolName: invocation.toolName,
      summary: outcome.summary,
      ...(outcome.error ? { error: executionError(outcome.error.code as never, outcome.error.message, true) } : {}),
    });

    const entry =
      invocation.mode === "dry_run"
        ? {
            executionId: invocation.execution.id,
            branchId: invocation.execution.branchId,
            agentId: invocation.execution.agentId,
            toolCallId: invocation.id,
            toolName: invocation.toolName,
            effect: invocation.tool.effect,
            disposition,
            summary: outcome.summary,
            ...(outcome.preview ? { preview: outcome.preview } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            timestamp: new Date().toISOString(),
          }
        : undefined;
    if (entry) this.options.recordDryRunEntry?.(entry);
    return { outcome, ...(entry ? { entry } : {}) };
  }
}

function blockedOutcome(mode: "execute" | "dry_run", code: string, message: string): RuntimeToolOutcome {
  return { ok: false, disposition: "blocked", mode, summary: message, error: { code, message } };
}

function shouldSkipMiddlewareForDryRun(middleware: AgentMiddleware, mode: "execute" | "dry_run") {
  return mode === "dry_run" && middleware.dryRun?.mode === "skip";
}

const MAX_PREVIEW_JSON_BYTES = 64 * 1024;
const MAX_PREVIEW_STRING_LENGTH = 2_000;

class PreviewValidationError extends Error {}

function sanitizePreview(preview: ToolPreview): ToolPreview {
  let serialized: string;
  try {
    serialized = JSON.stringify(preview, (_key, value: unknown) => {
      if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new PreviewValidationError("Dry-run preview contains a non-serializable value.");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new PreviewValidationError("Dry-run preview contains a non-finite number.");
      }
      return typeof value === "string" ? scrubText(value, MAX_PREVIEW_STRING_LENGTH) : value;
    });
  } catch (error) {
    if (error instanceof PreviewValidationError) throw error;
    throw new PreviewValidationError("Dry-run preview is not serializable.");
  }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_PREVIEW_JSON_BYTES) {
    throw new PreviewValidationError("Dry-run preview exceeds the report size limit.");
  }
  const sanitized = JSON.parse(serialized) as Partial<ToolPreview>;
  if (
    !isPlainRecord(sanitized) ||
    !["planned", "no_change", "indeterminate"].includes(sanitized.status ?? "") ||
    typeof sanitized.summary !== "string" ||
    !Array.isArray(sanitized.operations) ||
    !sanitized.operations.every(isPreviewOperation) ||
    !Array.isArray(sanitized.warnings) ||
    !sanitized.warnings.every((warning) => typeof warning === "string") ||
    (sanitized.fingerprint !== undefined && !isPreviewFingerprint(sanitized.fingerprint)) ||
    (sanitized.details !== undefined && !isPlainRecord(sanitized.details)) ||
    !["exact", "estimated", "unknown"].includes(sanitized.confidence ?? "")
  ) {
    throw new PreviewValidationError("Dry-run preview does not match the ToolPreview contract.");
  }
  return sanitized as ToolPreview;
}

function isPreviewOperation(value: unknown): boolean {
  if (!isPlainRecord(value) || !isPlainRecord(value.resource)) return false;
  return (
    typeof value.action === "string" &&
    typeof value.description === "string" &&
    typeof value.resource.kind === "string" &&
    typeof value.resource.identifier === "string" &&
    (value.reversible === undefined || typeof value.reversible === "boolean")
  );
}

function isPreviewFingerprint(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    typeof value.algorithm === "string" &&
    typeof value.value === "string" &&
    typeof value.observedAt === "string"
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubText(value: string, maxLength = 2_000): string {
  const redacted = value
    .replace(/\b(?:sk|pk|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}... [truncated]`;
}
