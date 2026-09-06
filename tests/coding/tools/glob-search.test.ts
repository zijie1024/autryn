import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { globSearchTool } from "@/coding/tools/glob-search";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-glob-search-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("globSearchTool", () => {
  test("finds files matching a glob pattern", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "index.ts"), "export const x = 1;\n");
    await writeFile(join(tempDir, "src", "view.tsx"), "export const View = null;\n");
    await writeFile(join(tempDir, "README.md"), "docs\n");

    const result = await globSearchTool.execute({
      description: "Find TypeScript sources",
      path: tempDir,
      pattern: "src/**/*.ts",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: tempDir,
        pattern: "src/**/*.ts",
        matchCount: 1,
      },
    });

    if (result.ok) {
      expect(result.data!.matches).toEqual([join(tempDir, "src", "index.ts")]);
      expect(result.data!.content).toContain(join(tempDir, "src", "index.ts"));
    }
  });

  test("returns structured error for invalid directory", async () => {
    const result = await globSearchTool.execute({
      description: "Find files in missing directory",
      path: join(tempDir, "missing-dir"),
      pattern: "**/*.ts",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_DIRECTORY",
    });
  });
});
