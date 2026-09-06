import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SessionRecord } from "@/sessions";
import { FileSessionStore, parseRevisionFilename, sessionDirectory, SessionError } from "@/sessions";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TEST_CWD = process.cwd();
const TEST_PROJECT_KEY = TEST_CWD.toLowerCase();

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "autryn-file-sessions-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("FileSessionStore", () => {
  test("commits immutable revisions and keeps the latest two snapshots", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, record(1));
    await store.commit(lease, 1, { ...record(2), name: "two" });
    await store.commit(lease, 2, { ...record(3), name: "three" });
    await lease.release();

    const dir = sessionDirectory(root, SESSION_ID);
    expect(await exists(path.join(dir, "0000000000000001.json"))).toBe(false);
    expect(await exists(path.join(dir, "0000000000000002.json"))).toBe(true);
    expect(await exists(path.join(dir, "0000000000000003.json"))).toBe(true);
    expect((await store.load(SESSION_ID)).name).toBe("three");
  });

  test("clear commits write an intent and remove old transcript revisions", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, record(1));
    await store.commit(lease, 1, recordWithMessage(2));
    await store.commitClear(lease, 2, record(3));
    await lease.release();

    const dir = sessionDirectory(root, SESSION_ID);
    expect(await exists(path.join(dir, "clear.intent"))).toBe(false);
    expect(await exists(path.join(dir, "0000000000000001.json"))).toBe(false);
    expect(await exists(path.join(dir, "0000000000000002.json"))).toBe(false);
    expect(await exists(path.join(dir, "0000000000000003.json"))).toBe(true);
    expect((await store.load(SESSION_ID)).messages).toEqual([]);
  });

  test("unfinished clear intent blocks revival of an old transcript", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, recordWithMessage(1));
    await lease.release();
    await writeFile(path.join(sessionDirectory(root, SESSION_ID), "clear.intent"), "{}", "utf8");

    await expect(store.load(SESSION_ID)).rejects.toThrow(SessionError);
    expect((await store.list({ includeAllProjects: true })).find((item) => item.id === SESSION_ID)?.health).toBe(
      "clear_pending",
    );
  });

  test("exclusive lease and revision CAS reject concurrent writers", async () => {
    const first = new FileSessionStore({ sessionsRoot: root, ownerId: "one" });
    const second = new FileSessionStore({ sessionsRoot: root, ownerId: "two" });
    const lease = await first.acquire(SESSION_ID, { create: true });
    await expect(second.acquire(SESSION_ID)).rejects.toThrow(SessionError);
    await first.commit(lease, 0, record(1));
    await lease.release();

    const stale = await first.acquire(SESSION_ID);
    const current = await second.acquire(SESSION_ID, { force: true });
    await second.commit(current, 1, record(2));
    await current.release();
    await expect(first.commit(stale, 1, record(2))).rejects.toThrow(SessionError);
  });

  test("same-owner nested lease keeps the outer attach lock until final release", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner", heartbeatIntervalMs: 0 });
    const outer = await store.acquire(SESSION_ID, { create: true });
    await store.commit(outer, 0, record(1));
    const nested = await store.acquire(SESSION_ID);
    expect(nested).toBe(outer);
    await nested.release();

    const leasePath = path.join(sessionDirectory(root, SESSION_ID), "lease.json");
    expect(await exists(leasePath)).toBe(true);
    await outer.release();
    expect(await exists(leasePath)).toBe(false);
  });

  test("lease heartbeat updates in place and stops after release", async () => {
    let tick = 0;
    const store = new FileSessionStore({
      sessionsRoot: root,
      ownerId: "owner",
      heartbeatIntervalMs: 5,
      now: () => `2026-08-27T00:00:0${tick++}.000Z`,
    });
    const lease = await store.acquire(SESSION_ID, { create: true });
    const leasePath = path.join(sessionDirectory(root, SESSION_ID), "lease.json");
    const initial = JSON.parse(await readFile(leasePath, "utf8")) as { heartbeatAt: string };
    await wait(30);
    const updated = JSON.parse(await readFile(leasePath, "utf8")) as { heartbeatAt: string };
    expect(updated.heartbeatAt).not.toBe(initial.heartbeatAt);

    await lease.release();
    expect(await exists(leasePath)).toBe(false);
    await wait(20);
    expect(await exists(leasePath)).toBe(false);
  });

  test("stale same-host lease is cleared only when pid is proven dead", async () => {
    const first = new FileSessionStore({ sessionsRoot: root, ownerId: "one", heartbeatIntervalMs: 0 });
    const lease = await first.acquire(SESSION_ID, { create: true });
    await first.commit(lease, 0, record(1));
    await lease.release();

    const leasePath = path.join(sessionDirectory(root, SESSION_ID), "lease.json");
    await writeFile(
      leasePath,
      `${JSON.stringify({
        sessionId: SESSION_ID,
        ownerId: "dead-owner",
        pid: 123456,
        hostname: os.hostname(),
        startedAt: "2026-08-27T00:00:00.000Z",
        heartbeatAt: "2026-08-27T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const second = new FileSessionStore({
      sessionsRoot: root,
      ownerId: "two",
      heartbeatIntervalMs: 0,
      processAlive: () => false,
    });
    const recovered = await second.acquire(SESSION_ID);
    expect(recovered.ownerId).toBe("two");
    await recovered.release();
  });

  test("live same-host lease is not cleared as stale", async () => {
    const first = new FileSessionStore({ sessionsRoot: root, ownerId: "one", heartbeatIntervalMs: 0 });
    const lease = await first.acquire(SESSION_ID, { create: true });
    await first.commit(lease, 0, record(1));
    await lease.release();

    const leasePath = path.join(sessionDirectory(root, SESSION_ID), "lease.json");
    await writeFile(
      leasePath,
      `${JSON.stringify({
        sessionId: SESSION_ID,
        ownerId: "alive-owner",
        pid: 123456,
        hostname: os.hostname(),
        startedAt: "2026-08-27T00:00:00.000Z",
        heartbeatAt: "2026-08-27T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const second = new FileSessionStore({
      sessionsRoot: root,
      ownerId: "two",
      heartbeatIntervalMs: 0,
      processAlive: () => true,
    });
    await expect(second.acquire(SESSION_ID)).rejects.toThrow(SessionError);
  });

  test("lists corrupted sessions without hiding healthy ones", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, record(1));
    await lease.release();

    const badId = "22222222-2222-4222-8222-222222222222";
    const badDir = sessionDirectory(root, badId);
    await mkdir(badDir, { recursive: true });
    await writeFile(path.join(badDir, "0000000000000001.json"), "{ bad json", "utf8");

    const list = await store.list({ includeAllProjects: true });
    expect(list.map((item) => item.id).sort()).toEqual([SESSION_ID, badId].sort());
    expect(list.find((item) => item.id === badId)?.health).toBe("corrupted");
  });

  test("path helpers reject traversal and parse only revision files", () => {
    expect(() => sessionDirectory(root, "../x")).toThrow(SessionError);
    expect(parseRevisionFilename("0000000000000001.json")).toBe(1);
    expect(parseRevisionFilename("../0000000000000001.json")).toBeNull();
    expect(parseRevisionFilename("lease.json")).toBeNull();
  });

  test("delete renames and removes one concrete session directory", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, record(1));
    await store.delete(lease, SESSION_ID);
    await expect(store.load(SESSION_ID)).rejects.toThrow(SessionError);
  });

  test("list marks sessions whose cwd no longer exists", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, {
      ...record(1),
      workspace: { cwd: path.join(root, "missing"), projectKey: "missing" },
    });
    await lease.release();

    expect((await store.list({ includeAllProjects: true })).find((item) => item.id === SESSION_ID)?.health).toBe(
      "cwd_missing",
    );
  });

  test("snapshots do not contain expanded secrets outside model config references", async () => {
    const store = new FileSessionStore({ sessionsRoot: root, ownerId: "owner" });
    const lease = await store.acquire(SESSION_ID, { create: true });
    await store.commit(lease, 0, record(1));
    await lease.release();
    const raw = await readFile(path.join(sessionDirectory(root, SESSION_ID), "0000000000000001.json"), "utf8");
    expect(raw).not.toContain("APIKey");
    expect(raw).not.toContain("sk-");
  });
});

function record(revision: number): SessionRecord {
  return {
    id: SESSION_ID,
    revision,
    name: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
    workspace: { cwd: TEST_CWD, projectKey: TEST_PROJECT_KEY },
    activeAgentGroupId: "default-coding",
    activeAgentId: "code",
    agentModelOverrides: {},
    activeExecutionMode: "execute",
    messages: [],
    turns: [],
    compaction: {
      version: 1,
      phases: [],
      nodes: [],
      checkpoint: {
        sourceRevision: revision,
        frontierNodeIds: [],
        policyVersion: "context-v1",
        summarySchemaVersion: 1,
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    },
  };
}

function recordWithMessage(revision: number): SessionRecord {
  return {
    ...record(revision),
    messages: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        turnId: "77777777-7777-4777-8777-777777777777",
        committedAt: "2026-08-27T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      },
    ],
  };
}

async function exists(file: string): Promise<boolean> {
  return Bun.file(file).exists();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
