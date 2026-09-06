import { access, mkdir } from "node:fs/promises";
import { parse } from "node:path";

import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureAbsolutePath } from "./tool-utils";

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Write to a file at an absolute path. Creates parent directories if they do not exist.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to write to the file. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute path to the file to write to."),
    content: z.string().describe("The content to write to the file."),
  }),
  effect: {
    kind: "mutation",
    scope: "workspace",
    reversible: false,
    description: "Creates or replaces a file in the workspace.",
  },
  execute: async ({ path, content }) => {
    const absolute = ensureAbsolutePath(path);
    if (!absolute.ok) {
      return errorToolResult(absolute.error, "INVALID_PATH", { path });
    }

    try {
      // 确保父目录存在
      const parentDir = parse(path).dir;
      if (!(await pathExists(parentDir))) {
        await mkdir(parentDir, { recursive: true });
      }

      const file = Bun.file(path);
      await file.write(content);
      return okToolResult(`Successfully wrote ${content.length} chars to ${path}`, {
        path,
        chars: content.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to write file: ${path}`, "WRITE_FAILED", { path, message });
    }
  },
  preview: async ({ path, content }) => {
    const absolute = ensureAbsolutePath(path);
    if (!absolute.ok) throw new Error(absolute.error);
    const file = Bun.file(path);
    const existed = await file.exists();
    const before = existed ? await file.text() : "";
    const changed = before !== content;
    return {
      status: changed ? "planned" : "no_change",
      summary: changed
        ? `${existed ? "Would replace" : "Would create"} ${path} with ${content.length} chars.`
        : `No change for ${path}.`,
      operations: changed
        ? [
            {
              action: existed ? "replace_file" : "create_file",
              resource: { kind: "file", identifier: path },
              description: `${existed ? "Replace" : "Create"} file content.`,
              before: existed ? { chars: before.length } : undefined,
              after: { chars: content.length },
              reversible: existed,
            },
          ]
        : [],
      warnings: [],
      confidence: "exact",
    };
  },
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
