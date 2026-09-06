import { stat } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureAbsolutePath } from "./tool-utils";

export const fileInfoTool = defineTool({
  name: "file_info",
  description: "Return metadata about a file or directory at an absolute path.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to inspect the path. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to inspect."),
  }),
  effect: {
    kind: "read",
    scope: "workspace",
    description: "Reads file metadata without modifying workspace state.",
  },
  execute: async ({ path }) => {
    const absolute = ensureAbsolutePath(path);
    if (!absolute.ok) {
      return errorToolResult(absolute.error, "INVALID_PATH", { path });
    }

    try {
      const info = await stat(path);
      const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      return okToolResult(`Inspected ${kind}: ${path}`, {
        path,
        kind,
        size: info.size,
        modifiedTime: info.mtime.toISOString(),
        createdTime: info.birthtime.toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to inspect path: ${path}`, "STAT_FAILED", { path, message });
    }
  },
});
