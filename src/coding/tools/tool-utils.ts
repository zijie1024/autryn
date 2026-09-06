import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function ensureAbsolutePath(path: string) {
  if (!isAbsolute(path)) {
    return { ok: false as const, error: `Path must be absolute: ${path}` };
  }
  return { ok: true as const, path };
}

export async function ensureDirectoryPath(path: string) {
  const absolute = ensureAbsolutePath(path);
  if (!absolute.ok) {
    return absolute;
  }

  try {
    const dirStat = await stat(path);
    if (!dirStat.isDirectory()) {
      return { ok: false as const, error: `Path exists but is not a directory: ${path}` };
    }
    return { ok: true as const, path };
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { ok: false as const, error: `Directory does not exist: ${path}` };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false as const, error: `Directory is inaccessible: ${path} (${message})` };
  }
}

export function isWithinDirectory(root: string, target: string) {
  const relativePath = relative(resolve(root), resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`));
}

export function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}
