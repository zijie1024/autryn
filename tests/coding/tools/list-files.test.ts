import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { listFilesTool } from "@/coding/tools/list-files";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-list-files-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("listFilesTool", () => {
  test("lists directory entries recursively", async () => {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "README.md"), "docs\n");
    await writeFile(join(tempDir, "src", "index.ts"), "export {};\n");

    const result = await listFilesTool.execute({
      description: "Inspect project tree",
      path: tempDir,
      recursive: true,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: tempDir,
        totalEntries: 3,
        shownEntries: 3,
        truncated: false,
      },
    });

    if (result.ok) {
      expect(result.data!.entries).toEqual(["README.md", "src/", "src/index.ts"]);
      expect(result.data!.content).toContain("src/index.ts");
    }
  });

  test("returns structured error for missing directory", async () => {
    const missingPath = join(tempDir, "missing-dir");

    const result = await listFilesTool.execute({
      description: "Inspect missing directory",
      path: missingPath,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INVALID_DIRECTORY",
    });
  });
});
