export type SessionErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_SELECTOR_AMBIGUOUS"
  | "SESSION_LOCKED"
  | "SESSION_STALE_LEASE_UNPROVEN"
  | "SESSION_REVISION_CONFLICT"
  | "SESSION_CORRUPTED"
  | "SESSION_RECORD_TOO_LARGE"
  | "SESSION_IO_ERROR"
  | "SESSION_SAVE_FAILED"
  | "SESSION_BUSY"
  | "SESSION_CWD_MISSING"
  | "SESSION_MODEL_MISSING"
  | "SESSION_AGENT_MISSING"
  | "SESSION_AGENT_OVERRIDE_INVALID"
  | "AGENT_GROUP_NOT_FOUND"
  | "AGENT_PROFILE_NOT_FOUND"
  | "SESSION_PERSISTENCE_BLOCKED"
  | "MODEL_CONFIG_NOT_FOUND"
  | "MODEL_CONFIG_IN_USE"
  | "MODEL_SELECTOR_AMBIGUOUS"
  | "MODEL_CAPABILITY_UNSUPPORTED"
  | "MODEL_CONTEXT_EXCEEDED"
  | "MODEL_RESOLUTION_FAILED"
  | "PROCESS_INTERRUPTED"
  | "INVALID_SESSION_RECORD"
  | "INVALID_SESSION_NAME"
  | "INVALID_SESSION_ID";

export class SessionError extends Error {
  readonly code: SessionErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SessionErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function sessionError(code: SessionErrorCode, message: string, details?: Record<string, unknown>): SessionError {
  return new SessionError(code, message, details ? { details } : {});
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof SessionError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return scrubSensitiveText(error.message);
  }
  return scrubSensitiveText(String(error));
}

export function scrubSensitiveText(value: string, maxLength = 2000): string {
  const withoutKeys = value
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=***");
  return withoutKeys.length > maxLength ? `${withoutKeys.slice(0, maxLength)}...` : withoutKeys;
}
