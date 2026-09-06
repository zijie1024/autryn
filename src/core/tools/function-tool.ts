import type { z } from "zod";

import type { StructuredToolError, StructuredToolResult } from "./structured-tool-result";

export type ExecutionMode = "execute" | "dry_run";

export type ToolEffectKind = "read" | "ephemeral" | "interaction" | "control" | "mutation" | "unknown";

export type ToolEffectScope = "process" | "workspace" | "application" | "system" | "external";

export interface ToolEffect {
  kind: ToolEffectKind;
  scope: ToolEffectScope;
  reversible?: boolean;
  description: string;
}

export interface PreviewOperation {
  action: string;
  resource: {
    kind: string;
    identifier: string;
  };
  description: string;
  before?: unknown;
  after?: unknown;
  reversible?: boolean;
}

export interface PreviewFingerprint {
  algorithm: string;
  value: string;
  observedAt: string;
}

export interface ToolPreview {
  status: "planned" | "no_change" | "indeterminate";
  summary: string;
  operations: PreviewOperation[];
  warnings: string[];
  confidence: "exact" | "estimated" | "unknown";
  fingerprint?: PreviewFingerprint;
  details?: Record<string, unknown>;
}

export type ToolDisposition = "executed" | "previewed" | "blocked" | "rejected";

export interface RuntimeToolOutcome<T = unknown> {
  ok: boolean;
  disposition: ToolDisposition;
  mode: ExecutionMode;
  summary: string;
  data?: T;
  preview?: ToolPreview;
  error?: {
    code: string;
    message: string;
  };
}

export interface ToolExecutionContext {
  mode: ExecutionMode;
  signal: AbortSignal;
  execution: unknown;
  toolCallId: string;
}

export interface ToolPreviewContext {
  mode: "dry_run";
  signal: AbortSignal;
  execution: unknown;
  toolCallId: string;
}

/**
 * 声明了参数 schema 与调用函数的可执行 tool。
 */
export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  name: string;
  description: string;
  parameters: P;
  effect: ToolEffect;
  execute: (input: z.infer<P>, context?: ToolExecutionContext | AbortSignal) => Promise<R>;
  preview?: (input: z.infer<P>, context: ToolPreviewContext) => Promise<ToolPreview>;
}

/** 声明一个 FunctionTool。 */
export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>({
  name,
  description,
  parameters,
  effect,
  execute,
  preview,
}: {
  name: string;
  description: string;
  parameters: P;
  effect: ToolEffect;
  execute: (input: z.infer<P>, context: ToolExecutionContext) => Promise<R>;
  preview?: (input: z.infer<P>, context: ToolPreviewContext) => Promise<ToolPreview>;
}): FunctionTool<P, R> {
  return {
    name,
    description,
    parameters,
    effect,
    execute: (input, context) => execute(input, normalizeToolExecutionContext(context)),
    ...(preview ? { preview } : {}),
  };
}

function normalizeToolExecutionContext(context?: ToolExecutionContext | AbortSignal): ToolExecutionContext {
  if (context && "aborted" in context) {
    return defaultToolExecutionContext(context);
  }
  return context ?? defaultToolExecutionContext();
}

function defaultToolExecutionContext(signal = new AbortController().signal): ToolExecutionContext {
  return {
    mode: "execute",
    signal,
    execution: {},
    toolCallId: "direct-call",
  };
}

export function isStructuredToolError(result: unknown): result is StructuredToolError {
  return Boolean(result && typeof result === "object" && "ok" in result && result.ok === false);
}

export function toRuntimeToolOutcome<T>(
  result: T,
  disposition: Exclude<ToolDisposition, "blocked" | "rejected">,
  mode: ExecutionMode,
  fallbackSummary: string,
): RuntimeToolOutcome<T> {
  const structured = result as StructuredToolResult | unknown;
  if (isStructuredToolError(structured)) {
    return {
      ok: false,
      disposition: "rejected",
      mode,
      summary: structured.summary,
      error: { code: structured.code ?? "TOOL_FAILED", message: structured.error },
      data: result,
    };
  }
  if (structured && typeof structured === "object" && "ok" in structured && structured.ok === true) {
    const success = structured as unknown as { summary: string; data?: unknown };
    return {
      ok: true,
      disposition,
      mode,
      summary: success.summary,
      ...(success.data !== undefined ? { data: success.data as T } : { data: result }),
    };
  }
  return { ok: true, disposition, mode, summary: fallbackSummary, data: result };
}
