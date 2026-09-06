import { SessionError } from "./errors";
import { isCanonicalUuid } from "./session-schema";
import type { SessionSummary } from "./session-types";

const uuidPrefixRegex = /^[0-9a-f]{8,}$/i;

export function resolveSessionSelector(selector: string, sessions: SessionSummary[]): SessionSummary {
  const normalized = selector.trim();
  if (!normalized) {
    throw new SessionError("SESSION_NOT_FOUND", "Session selector is empty.");
  }

  const lower = normalized.toLowerCase();
  if (isCanonicalUuid(lower)) {
    const match = sessions.find((session) => session.id === lower);
    if (!match) throw new SessionError("SESSION_NOT_FOUND", `No session found for ${normalized}.`);
    return match;
  }

  if (uuidPrefixRegex.test(normalized)) {
    const matches = sessions.filter((session) => session.id.startsWith(lower));
    return uniqueMatch(normalized, matches);
  }

  const name = normalized.normalize("NFC");
  const matches = sessions.filter((session) => session.name === name);
  return uniqueMatch(normalized, matches);
}

function uniqueMatch(selector: string, matches: SessionSummary[]): SessionSummary {
  if (matches.length === 0) {
    throw new SessionError("SESSION_NOT_FOUND", `No session found for ${selector}.`);
  }
  if (matches.length > 1) {
    throw new SessionError(
      "SESSION_SELECTOR_AMBIGUOUS",
      `Session selector ${selector} matched more than one session.`,
      {
        details: {
          matches: matches.map((session) => ({
            id: session.shortId,
            name: session.name,
            updatedAt: session.updatedAt,
          })),
        },
      },
    );
  }
  return matches[0]!;
}
