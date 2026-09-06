import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { fileInfoTool } from "@/coding/tools/file-info";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-file-info-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("fileInfoTool", () => {
  test("returns metadata for a file", async () => {
    const filePath = join(tempDir, "demo.txt");
    await writeFile(filePath, "hello\n");

    const result = await fileInfoTool.execute({
      description: "Inspect demo file",
      path: filePath,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: filePath,
        kind: "file",
        size: 6,
      },
    });

    if (result.ok) {
      expect(result.data!.modifiedTime).toMatch(/T/);
      expect(result.data!.createdTime).toMatch(/T/);
    }
  });

  test("returns structured error for relative path", async () => {
    const result = await fileInfoTool.execute({
      description: "Inspect invalid path",
      path: "demo.txt",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
});
