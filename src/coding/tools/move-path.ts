import { rename, stat } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureAbsolutePath } from "./tool-utils";

export const movePathTool = defineTool({
  name: "move_path",
  description: "Move or rename a file or directory between absolute paths.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to move the path. Always place `description` as the first parameter."),
    from: z.string().describe("The absolute source path."),
    to: z.string().describe("The absolute target path."),
  }),
  effect: {
    kind: "mutation",
    scope: "workspace",
    reversible: true,
    description: "Moves or renames a workspace path.",
  },
  execute: async ({ from, to }) => {
    const source = ensureAbsolutePath(from);
    if (!source.ok) {
      return errorToolResult(source.error, "INVALID_SOURCE_PATH", { from, to });
    }

    const target = ensureAbsolutePath(to);
    if (!target.ok) {
      return errorToolResult(target.error, "INVALID_TARGET_PATH", { from, to });
    }

    try {
      await rename(from, to);
      return okToolResult(`Moved path from ${from} to ${to}`, { from, to });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to move path from ${from} to ${to}`, "MOVE_FAILED", { from, to, message });
    }
  },
  preview: async ({ from, to }) => {
    const source = ensureAbsolutePath(from);
    if (!source.ok) throw new Error(source.error);
    const target = ensureAbsolutePath(to);
    if (!target.ok) throw new Error(target.error);
    const sourceInfo = await stat(from);
    let targetExists = false;
    try {
      await stat(to);
      targetExists = true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    return {
      status: from === to ? "no_change" : "planned",
      summary: from === to ? `No move needed for ${from}.` : `Would move ${from} to ${to}.`,
      operations:
        from === to
          ? []
          : [
              {
                action: "move_path",
                resource: { kind: sourceInfo.isDirectory() ? "directory" : "file", identifier: from },
                description: `Move path to ${to}.`,
                before: { path: from },
                after: { path: to, targetExists },
                reversible: !targetExists,
              },
            ],
      warnings: targetExists ? [`Target already exists: ${to}`] : [],
      confidence: "exact",
    };
  },
});
