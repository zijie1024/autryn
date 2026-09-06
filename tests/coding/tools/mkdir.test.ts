import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mkdirTool } from "@/coding/tools/mkdir";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-mkdir-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("mkdirTool", () => {
  test("creates a directory recursively", async () => {
    const dirPath = join(tempDir, "nested", "child");

    const result = await mkdirTool.execute({
      description: "Create nested directory",
      path: dirPath,
      recursive: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: dirPath,
        recursive: true,
      },
    });

    await expect(stat(dirPath)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  test("returns structured error for relative path", async () => {
    const result = await mkdirTool.execute({
      description: "Create invalid path",
      path: "relative/path",
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_PATH",
    });
  });
});
