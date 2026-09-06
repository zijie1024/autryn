import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCodingAgent } from "@/coding/agents/lead-agent";
import type { ModelProvider } from "@/core";
import { Model } from "@/core";

const fakeProvider: ModelProvider = {
  async invoke() {
    throw new Error("provider must not be invoked during construction");
  },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error("provider must not be invoked during construction");
  },
};

let tempHome: string;
let tempCwd: string;
let previousHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "autryn-session-home-"));
  tempCwd = await mkdtemp(join(tmpdir(), "autryn-session-cwd-"));
  await mkdir(tempHome, { recursive: true });
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
  await rm(tempCwd, { recursive: true, force: true });
});

describe("session semantics: new process starts empty", () => {
  test("a fresh coding agent has an empty transcript", async () => {
    const model = new Model("fake-model", fakeProvider);
    const agent = await createCodingAgent({ model, cwd: tempCwd, askUser: async () => "allow_once" });
    expect(agent.messages).toEqual([]);
  });

  test("saved input history is never restored into the transcript", async () => {
    await writeFile(join(tempHome, "history.txt"), "prior secret input from another process\n", "utf8");

    const model = new Model("fake-model", fakeProvider);
    const agent = await createCodingAgent({ model, cwd: tempCwd, askUser: async () => "allow_once" });

    expect(agent.messages).toEqual([]);
    expect(JSON.stringify(agent.messages)).not.toContain("prior secret input");
  });

  test("AGENTS.md is loaded into the Agent prompt, not the session transcript", async () => {
    await writeFile(join(tempCwd, "AGENTS.md"), "project guidance marker\n", "utf8");

    const model = new Model("fake-model", fakeProvider);
    const agent = await createCodingAgent({ model, cwd: tempCwd, askUser: async () => "allow_once" });

    expect(agent.messages).toEqual([]);
    const injected = agent.prompt;
    expect(injected).toContain("AGENTS.md");
    expect(injected).toContain("project guidance marker");
  });
});
