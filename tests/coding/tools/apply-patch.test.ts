import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyPatchTool } from "@/coding/tools/apply-patch";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-apply-patch-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("applyPatchTool", () => {
  test("applies a simple patch to an existing file", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "alpha\nbeta\n");

    const patch = [`--- ${filePath}`, `+++ ${filePath}`, "@@ -1,2 +1,2 @@", " alpha", "-beta", "+gamma", ""].join("\n");

    const result = await applyPatchTool.execute({ description: "Patch demo file", patch });
    expect(result).toMatchObject({
      ok: true,
      data: {
        fileCount: 1,
        changedFiles: [filePath],
      },
    });

    expect(await readFile(filePath, "utf8")).toBe("alpha\ngamma\n");
  });

  test("rejects file deletion patches", async () => {
    const filePath = join(tempDir, "demo.txt");
    const patch = [`--- ${filePath}`, "+++ /dev/null", "@@ -1,1 +0,0 @@", "-hello", ""].join("\n");

    const result = await applyPatchTool.execute({ description: "Delete file", patch });
    expect(result).toMatchObject({
      ok: false,
      code: "DELETE_NOT_SUPPORTED",
    });
  });

  test("fails when hunk counts do not match contents", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "alpha\nbeta\n");

    const patch = [`--- ${filePath}`, `+++ ${filePath}`, "@@ -1,1 +1,1 @@", " alpha", "-beta", "+gamma", ""].join("\n");

    const result = await applyPatchTool.execute({ description: "Bad hunk counts", patch });
    expect(result).toMatchObject({
      ok: false,
      code: "PATCH_APPLY_FAILED",
    });
    if (!result.ok) {
      expect(result.error).toContain("Hunk count mismatch");
    }
  });
});
