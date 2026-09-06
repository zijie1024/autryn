import { readdir } from "node:fs/promises";
import { join } from "node:path";

import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureDirectoryPath, truncateText } from "./tool-utils";

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_CHARS = 12000;

async function walk(dir: string, maxDepth: number, prefix = "", depth = 0, entries: string[] = []) {
  const items = await readdir(dir, { withFileTypes: true });
  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const item of items) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    entries.push(item.isDirectory() ? `${relativePath}/` : relativePath);

    if (item.isDirectory() && depth < maxDepth) {
      await walk(join(dir, item.name), maxDepth, relativePath, depth + 1, entries);
    }
  }

  return entries;
}

export const listFilesTool = defineTool({
  name: "list_files",
  description: "List files and directories from an absolute path, with optional recursion.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to inspect the directory. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute directory path to inspect."),
    recursive: z.boolean().describe("Whether to recurse into subdirectories.").optional(),
    maxDepth: z.number().int().nonnegative().describe("Maximum recursion depth when recursive=true.").optional(),
    limit: z.number().int().positive().describe("Maximum number of entries to return.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return.").optional(),
  }),
  effect: {
    kind: "read",
    scope: "workspace",
    description: "Reads directory entries without modifying workspace state.",
  },
  execute: async ({ path, recursive, maxDepth, limit, maxChars }) => {
    const dirCheck = await ensureDirectoryPath(path);
    if (!dirCheck.ok) {
      return errorToolResult(dirCheck.error, "INVALID_DIRECTORY", { path });
    }

    const entries = await walk(path, recursive ? (maxDepth ?? 3) : 0);
    const capped = entries.slice(0, limit ?? DEFAULT_LIMIT);
    const limited = truncateText(capped.join("\n"), maxChars ?? DEFAULT_MAX_CHARS);

    return okToolResult(`Listed ${capped.length} entries under ${path}`, {
      path,
      totalEntries: entries.length,
      shownEntries: capped.length,
      truncated: limited.truncated || capped.length < entries.length,
      entries: capped,
      content: limited.text,
    });
  },
});
