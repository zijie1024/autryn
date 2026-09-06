import type { RuntimeToolOutcome, StructuredToolError, StructuredToolResult, StructuredToolSuccess } from "@/core";
import { getToolResultPolicy } from "@/runtime/tool-results/policy";

export type ToolErrorKind =
  | "invalid_input"
  | "unsupported"
  | "not_found"
  | "environment_missing"
  | "execution_failed"
  | "unknown";

export type NormalizedToolSuccess = StructuredToolSuccess & {
  raw: unknown;
};

export type NormalizedToolError = StructuredToolError & {
  errorKind: ToolErrorKind;
  raw: unknown;
};

export type NormalizedToolResult = NormalizedToolSuccess | NormalizedToolError;

export function inferToolErrorKind(code?: string): ToolErrorKind {
  if (!code) return "unknown";
  if (code.startsWith("INVALID_")) return "invalid_input";
  if (code.endsWith("_NOT_SUPPORTED")) return "unsupported";
  if (code === "RG_NOT_FOUND") return "environment_missing";
  if (code === "FILE_NOT_FOUND" || code.endsWith("_NOT_FOUND")) return "not_found";
  if (code.endsWith("_FAILED")) return "execution_failed";
  return "unknown";
}

function isStructuredToolSuccess(value: unknown): value is StructuredToolSuccess {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "summary" in value &&
    typeof value.summary === "string"
  );
}

function isStructuredToolError(value: unknown): value is StructuredToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false &&
    "summary" in value &&
    typeof value.summary === "string" &&
    "error" in value &&
    typeof value.error === "string"
  );
}

export function normalizeToolResult(result: unknown): NormalizedToolResult {
  if (isStructuredToolSuccess(result)) {
    return {
      ok: true,
      summary: result.summary,
      ...(result.data !== undefined ? { data: result.data } : {}),
      raw: result,
    };
  }

  if (isStructuredToolError(result)) {
    return {
      ok: false,
      summary: result.summary,
      error: result.error,
      ...(result.code ? { code: result.code } : {}),
      ...(result.details ? { details: result.details } : {}),
      errorKind: inferToolErrorKind(result.code),
      raw: result,
    };
  }

  if (typeof result === "string" && result.startsWith("Error:")) {
    const error = result.slice("Error:".length).trim() || "Tool execution failed.";
    return {
      ok: false,
      summary: error,
      error,
      errorKind: "unknown",
      raw: result,
    };
  }

  const summary = stringifyValue(result);
  return {
    ok: true,
    summary,
    ...(result !== undefined ? { data: result } : {}),
    raw: result,
  };
}

export function formatToolResultForMessage({ toolName, result }: { toolName: string; result: unknown }): string {
  if (toolName === "read_file" && typeof result === "string") {
    return result;
  }

  const policy = getToolResultPolicy(toolName);
  if (isRuntimeToolOutcome(result)) {
    return stringifyWithinLimit(
      result.ok
        ? {
            ok: true,
            summary: result.summary,
            disposition: result.disposition,
            mode: result.mode,
            ...(result.data !== undefined ? { data: result.data } : {}),
            ...(result.preview ? { preview: result.preview } : {}),
          }
        : {
            ok: false,
            summary: result.summary,
            error: result.error?.message ?? result.summary,
            ...(result.error?.code ? { code: result.error.code } : {}),
            disposition: result.disposition,
            mode: result.mode,
            ...(result.preview ? { preview: result.preview } : {}),
          },
      policy.maxStringLength,
      result.ok
        ? { ok: true, summary: truncateSummary(result.summary) }
        : {
            ok: false,
            summary: truncateSummary(result.summary),
            error: truncateSummary(result.error?.message ?? result.summary),
            ...(result.error?.code ? { code: result.error.code } : {}),
          },
    );
  }

  const normalized = normalizeToolResult(result);

  if (!normalized.ok) {
    return stringifyWithinLimit(
      {
        ok: false,
        summary: normalized.summary,
        error: normalized.error,
        ...(normalized.code ? { code: normalized.code } : {}),
        ...(normalized.details ? { details: normalized.details } : {}),
      },
      policy.maxStringLength,
      {
        ok: false,
        summary: truncateSummary(normalized.summary),
        error: truncateSummary(normalized.error),
        ...(normalized.code ? { code: normalized.code } : {}),
      },
    );
  }

  if (policy.preferSummaryOnly || !policy.includeData) {
    return JSON.stringify({ ok: true, summary: truncateSummary(normalized.summary) } satisfies StructuredToolResult);
  }

  return stringifyWithinLimit(
    {
      ok: true,
      summary: normalized.summary,
      ...(normalized.data !== undefined ? { data: normalized.data } : {}),
    },
    policy.maxStringLength,
    {
      ok: true,
      summary: truncateSummary(normalized.summary),
    },
  );
}

function isRuntimeToolOutcome(value: unknown): value is RuntimeToolOutcome {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    "summary" in value &&
    "disposition" in value &&
    "mode" in value &&
    typeof value.summary === "string"
  );
}

function stringifyValue(value: unknown) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable object]";
    }
  }
  return String(value);
}

function stringifyWithinLimit(
  payload: unknown,
  maxLength: number | undefined,
  fallback: StructuredToolResult,
): string {
  const serialized = JSON.stringify(payload);
  if (!maxLength || serialized.length <= maxLength) {
    return serialized;
  }

  const fallbackSerialized = JSON.stringify(fallback);
  if (!maxLength || fallbackSerialized.length <= maxLength) {
    return fallbackSerialized;
  }

  if (fallback.ok) {
    return JSON.stringify({
      ok: true,
      summary: fallback.summary.slice(0, Math.max(0, maxLength - 32)),
    } satisfies StructuredToolResult);
  }

  return JSON.stringify({
    ok: false,
    summary: fallback.summary.slice(0, Math.max(0, maxLength - 64)),
    error: fallback.error.slice(0, Math.max(0, maxLength - 64)),
    ...(fallback.code ? { code: fallback.code } : {}),
  } satisfies StructuredToolResult);
}

function truncateSummary(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}
