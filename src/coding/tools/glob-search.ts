import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureDirectoryPath, truncateText } from "./tool-utils";

const DEFAULT_LIMIT = 200;
const DEFAULT_MAX_CHARS = 12000;

export const globSearchTool = defineTool({
  name: "glob_search",
  description: "Find files matching a glob pattern under an absolute directory.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to find files. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute directory path to search within."),
    pattern: z.string().describe("Glob pattern, for example **/*.ts or src/**/*.tsx."),
    limit: z.number().int().positive().describe("Maximum number of matches to return.").optional(),
    maxChars: z.number().int().positive().describe("Maximum characters to return.").optional(),
  }),
  effect: {
    kind: "read",
    scope: "workspace",
    description: "Scans file names without modifying workspace state.",
  },
  execute: async ({ path, pattern, limit, maxChars }) => {
    const dirCheck = await ensureDirectoryPath(path);
    if (!dirCheck.ok) {
      return errorToolResult(dirCheck.error, "INVALID_DIRECTORY", { path, pattern });
    }

    const matches: string[] = [];
    try {
      const globber = new Bun.Glob(pattern);
      for await (const entry of globber.scan({ cwd: path, absolute: true })) {
        matches.push(entry);
        if (matches.length >= (limit ?? DEFAULT_LIMIT)) {
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`glob_search failed for pattern ${pattern}`, "GLOB_SEARCH_FAILED", {
        path,
        pattern,
        message,
      });
    }

    const limited = truncateText(matches.join("\n"), maxChars ?? DEFAULT_MAX_CHARS);
    return okToolResult(`Found ${matches.length} files matching ${pattern}`, {
      path,
      pattern,
      matchCount: matches.length,
      truncated: limited.truncated,
      matches,
      content: limited.text,
    });
  },
});
