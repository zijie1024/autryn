export type MemoryErrorCode =
  | "MEMORY_DISABLED"
  | "MEMORY_ACCESS_DENIED"
  | "MEMORY_SCOPE_INVALID"
  | "MEMORY_POLICY_INVALID"
  | "MEMORY_SCOPE_MISMATCH"
  | "MEMORY_REFERENCE_INVALID"
  | "MEMORY_NOT_FOUND"
  | "MEMORY_ALREADY_EXISTS"
  | "MEMORY_LOCKED"
  | "MEMORY_REVISION_CONFLICT"
  | "MEMORY_LIMIT_EXCEEDED"
  | "MEMORY_SYMLINK_REJECTED"
  | "MEMORY_CONTENT_REJECTED"
  | "MEMORY_READ_FAILED"
  | "MEMORY_WRITE_FAILED"
  | "MEMORY_PREVIEW_FAILED"
  | "MEMORY_BOOTSTRAP_TOO_LARGE";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: MemoryErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function memoryError(
  code: MemoryErrorCode,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): MemoryError {
  return new MemoryError(code, message, options);
}

/**
 * 将 Memory 错误转换为可安全展示给用户的信息。
 * 与 Session 层保持一致：只清洗凭据模式，不尝试用正则删除本地绝对路径，
 * 而是要求实现方从一开始就用 Short ID 而非完整路径构造错误消息。
 */
export function publicMemoryErrorMessage(error: unknown, maxLength = 2000): string {
  const base =
    error instanceof MemoryError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  const cleaned = base
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(api[_-]?key|authorization|bearer|token)\s*[:=]\s*[^\s,;]+/gi, "$1=***");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
}
