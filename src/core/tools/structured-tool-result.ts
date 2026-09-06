export type StructuredToolSuccess<T = unknown> = {
  ok: true;
  summary: string;
  data?: T;
};

export type StructuredToolError = {
  ok: false;
  summary: string;
  error: string;
  code?: string;
  details?: Record<string, unknown>;
};

export type StructuredToolResult<T = unknown> = StructuredToolSuccess<T> | StructuredToolError;
