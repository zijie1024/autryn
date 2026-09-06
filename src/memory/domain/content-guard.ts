import { MemoryError } from "./errors";

interface SensitivePattern {
  name: string;
  regex: RegExp;
}

const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { name: "API key", regex: /\b(?:sk|pk|gh[pousr]_|github_pat_|AIza)[A-Za-z0-9_-]{16,}\b/ },
  { name: "bearer token", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i },
  { name: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  {
    name: "connection string",
    regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp|rediss):\/\/[^\s"']+:[^\s"']+@/i,
  },
  { name: "AWS credential", regex: /\b(?:AKIA[0-9A-Z]{16}|aws_secret_access_key\s*[:=]\s*[^\s]+)/i },
];

/**
 * 检测常见的凭据模式。返回命中类型，否则返回 null。
 * 该检测是启发式的：无法覆盖全部敏感信息，Public API 与 TUI 仍须明确
 * Memory 是本地持久数据，用户可以查看和删除。
 */
export function detectSensitiveContent(text: string): string | null {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) || codePoint === 0x7f) {
      return "disallowed control character";
    }
  }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.regex.test(text)) return pattern.name;
  }
  return null;
}

export function assertContentSafe(text: string): void {
  const detected = detectSensitiveContent(text);
  if (detected) {
    throw new MemoryError(
      "MEMORY_CONTENT_REJECTED",
      `Refusing to persist memory content that appears to contain a ${detected}.`,
    );
  }
}
