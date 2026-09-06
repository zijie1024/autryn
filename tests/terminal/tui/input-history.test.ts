import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getHistoryFilePath, loadHistoryFromDisk, saveHistoryToDisk } from "@/terminal/tui/hooks/use-input-history";

let tempHome: string;
let previousHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "autryn-input-history-"));
  previousHome = Bun.env.AUTRYN_HOME;
  Bun.env.AUTRYN_HOME = tempHome;
});

afterEach(async () => {
  if (previousHome === undefined) {
    delete Bun.env.AUTRYN_HOME;
  } else {
    Bun.env.AUTRYN_HOME = previousHome;
  }
  await rm(tempHome, { recursive: true, force: true });
});

describe("input history file", () => {
  test("lives in AUTRYN_HOME/history.txt and survives across process-like reloads", () => {
    expect(getHistoryFilePath()).toBe(join(tempHome, "history.txt"));
    expect(loadHistoryFromDisk()).toEqual([]);

    saveHistoryToDisk(["first prompt", "second prompt"]);
    // 模拟新进程读取同一文件。
    expect(loadHistoryFromDisk()).toEqual(["first prompt", "second prompt"]);
  });

  test("is capped at the most recent entries", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i}`);
    saveHistoryToDisk(lines);
    const loaded = loadHistoryFromDisk();
    expect(loaded).toHaveLength(100);
    expect(loaded[0]).toBe("line 20");
    expect(loaded[99]).toBe("line 119");
  });

  test("stores only raw input lines, never a serialized transcript", async () => {
    saveHistoryToDisk(["what did we discuss?"]);
    const raw = await readFile(join(tempHome, "history.txt"), "utf8");
    expect(raw).toBe("what did we discuss?\n");
    expect(raw).not.toContain("assistant");
    expect(raw).not.toContain("role");
  });
});
