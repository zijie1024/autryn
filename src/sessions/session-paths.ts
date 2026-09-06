import { mkdir } from "node:fs/promises";
import path from "node:path";

import { SessionError } from "./errors";
import { getAutrynHomePath } from "./home";
import { isCanonicalUuid } from "./session-schema";

export const SESSIONS_DIR = "sessions";

export function getSessionsRoot(home = getAutrynHomePath()): string {
  return path.resolve(home, SESSIONS_DIR);
}

export async function ensureSessionsRoot(home = getAutrynHomePath()): Promise<string> {
  const root = getSessionsRoot(home);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export function sessionDirectory(root: string, sessionId: string): string {
  const id = normalizeSessionId(sessionId);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, id);
  if (!isPathInside(resolvedRoot, resolved)) {
    throw new SessionError("INVALID_SESSION_ID", "Session id resolved outside the sessions directory.");
  }
  return resolved;
}

export function revisionFilename(revision: number): string {
  if (!Number.isInteger(revision) || revision <= 0) {
    throw new SessionError("INVALID_SESSION_RECORD", "Revision must be a positive integer.");
  }
  return `${revision.toString().padStart(16, "0")}.json`;
}

export function parseRevisionFilename(name: string): number | null {
  const match = name.match(/^([0-9]{16})\.json$/);
  if (!match) return null;
  const revision = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function normalizeSessionId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!isCanonicalUuid(id)) {
    throw new SessionError("INVALID_SESSION_ID", "Session id must be a canonical lowercase UUID v4.");
  }
  return id;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
