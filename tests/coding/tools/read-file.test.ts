import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { readFileTool } from "@/coding/tools/read-file";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-read-file-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("readFileTool", () => {
  test("returns raw content for whole-file reads", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "a\nb\n");

    const result = await readFileTool.execute({
      description: "Read the whole file",
      path: filePath,
    });

    expect(result).toBe("a\nb\n");
  });

  test("returns numbered lines for ranged reads", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "first\nsecond\nthird\n");

    const result = await readFileTool.execute({
      description: "Read a range",
      path: filePath,
      startLine: 2,
      endLine: 3,
    });

    expect(result).toContain("2: second");
    expect(result).toContain("3: third");
  });

  test("returns structured error for invalid range", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "first\nsecond\n");

    const result = await readFileTool.execute({
      description: "Bad range",
      path: filePath,
      startLine: 3,
      endLine: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_RANGE",
    });
  });

  test("returns structured error when file is missing", async () => {
    const filePath = join(tempDir, "missing.txt");
    const result = await readFileTool.execute({
      description: "Missing file",
      path: filePath,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "FILE_NOT_FOUND",
    });
  });
});
