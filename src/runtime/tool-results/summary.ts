export function summarizeToolResultText(content: string): string | null {
  if (content.startsWith("Error:")) {
    return content;
  }

  try {
    const parsed = JSON.parse(content) as {
      ok?: boolean;
      summary?: unknown;
      error?: unknown;
      code?: unknown;
    };

    if (parsed.ok === true && typeof parsed.summary === "string") {
      return parsed.summary;
    }

    if (parsed.ok === false) {
      const message = typeof parsed.summary === "string" ? parsed.summary : typeof parsed.error === "string" ? parsed.error : content;
      const code = typeof parsed.code === "string" ? parsed.code : null;
      return code ? `Error [${code}]: ${message}` : `Error: ${message}`;
    }
  } catch {
    return null;
  }

  return null;
}
