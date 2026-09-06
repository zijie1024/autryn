import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { grepSearchTool } from "@/coding/tools/grep-search";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-grep-search-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("grepSearchTool", () => {
  test("returns structured error for invalid directory", async () => {
    const result = await grepSearchTool.execute({
      description: "Search missing directory",
      path: join(tempDir, "missing-dir"),
      pattern: "needle",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_DIRECTORY",
    });
  });

  test("finds matches with ripgrep when available", async () => {
    await writeFile(join(tempDir, "alpha.txt"), "needle\nother\n");
    await writeFile(join(tempDir, "beta.txt"), "NEEDLE\n");

    const result = await grepSearchTool.execute({
      description: "Search for needle",
      path: tempDir,
      pattern: "needle",
    });

    if (!result.ok && result.code === "RG_NOT_FOUND") {
      expect(result.error).toContain("ripgrep");
      return;
    }

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: tempDir,
        pattern: "needle",
        totalMatches: 2,
        shownMatches: 2,
        caseSensitive: false,
      },
    });

    if (result.ok) {
      expect(result.data!.matches.some((line) => line.includes("alpha.txt:1:needle"))).toBe(true);
      expect(result.data!.matches.some((line) => line.includes("beta.txt:1:NEEDLE"))).toBe(true);
    }
  });
});
