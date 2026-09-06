import { mkdir, stat } from "node:fs/promises";

import z from "zod";

import { defineTool } from "@/core";

import { errorToolResult, okToolResult } from "./tool-result";
import { ensureAbsolutePath } from "./tool-utils";

export const mkdirTool = defineTool({
  name: "mkdir",
  description: "Create a directory at an absolute path.",
  parameters: z.object({
    description: z
      .string()
      .describe("Explain why you want to create the directory. Always place `description` as the first parameter."),
    path: z.string().describe("The absolute directory path to create."),
    recursive: z.boolean().describe("Whether to create parent directories recursively.").optional(),
  }),
  effect: {
    kind: "mutation",
    scope: "workspace",
    reversible: true,
    description: "Creates a directory in the workspace.",
  },
  execute: async ({ path, recursive }) => {
    const absolute = ensureAbsolutePath(path);
    if (!absolute.ok) {
      return errorToolResult(absolute.error, "INVALID_PATH", { path });
    }

    try {
      await mkdir(path, { recursive: recursive ?? true });
      return okToolResult(`Created directory: ${path}`, { path, recursive: recursive ?? true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorToolResult(`Failed to create directory: ${path}`, "MKDIR_FAILED", { path, message });
    }
  },
  preview: async ({ path, recursive }) => {
    const absolute = ensureAbsolutePath(path);
    if (!absolute.ok) throw new Error(absolute.error);
    try {
      const info = await stat(path);
      if (!info.isDirectory()) throw new Error(`Path exists but is not a directory: ${path}`);
      return {
        status: "no_change",
        summary: `Directory already exists: ${path}.`,
        operations: [],
        warnings: [],
        confidence: "exact",
      };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
      return {
        status: "planned",
        summary: `Would create directory: ${path}.`,
        operations: [
          {
            action: "create_directory",
            resource: { kind: "directory", identifier: path },
            description: "Create directory without writing during dry-run.",
            after: { recursive: recursive ?? true },
            reversible: true,
          },
        ],
        warnings: [],
        confidence: "exact",
      };
    }
  },
});
