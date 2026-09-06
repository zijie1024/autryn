import type { StructuredToolResult } from "@/core";

import { MemoryError } from "../domain";

export function okToolResult<T>(summary: string, data: T): StructuredToolResult<T> {
  return { ok: true, summary, data };
}

/** 把任意错误转换为带 code 的结构化 Tool Error，供 Model 恢复。 */
export function memoryErrorResult(error: unknown, fallbackCode: string): StructuredToolResult<never> {
  if (error instanceof MemoryError) {
    return { ok: false, summary: error.message, error: error.message, code: error.code };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, summary: message, error: message, code: fallbackCode };
}

export function memoryErrorCode(error: unknown, fallback: string): string {
  return error instanceof MemoryError ? error.code : fallback;
}
