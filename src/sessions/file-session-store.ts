import { constants } from "node:fs";
import { access, mkdir, open, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionError } from "./errors";
import {
  ensureSessionsRoot,
  isPathInside,
  normalizeSessionId,
  parseRevisionFilename,
  revisionFilename,
  sessionDirectory,
} from "./session-paths";
import { displaySessionName, parseSessionRecord, shortSessionId } from "./session-schema";
import type {
  CommitOutcome,
  DurableClearSessionStore,
  PublicMaintenanceWarning,
  SessionHealth,
  SessionLease,
  SessionRecord,
  SessionStore,
  SessionSummary,
} from "./session-types";

const MAX_RECORD_BYTES = 64 * 1024 * 1024;

interface FileSessionStoreOptions {
  home?: string;
  sessionsRoot?: string;
  ownerId?: string;
  now?: () => string;
  heartbeatIntervalMs?: number;
  processAlive?: (pid: number, hostname: string) => boolean | Promise<boolean>;
}

interface FileSessionLease extends SessionLease {
  dir: string;
  leasePath: string;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatTask: Promise<void> | null;
  released: boolean;
}

interface HeldLease {
  lease: FileSessionLease;
  refs: number;
}

interface LeasePayload {
  sessionId: string;
  ownerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
}

export class FileSessionStore implements SessionStore, DurableClearSessionStore {
  private readonly home?: string;
  private readonly explicitRoot?: string;
  private readonly ownerId: string;
  private readonly now: () => string;
  private readonly heartbeatIntervalMs: number;
  private readonly processAlive: (pid: number, hostname: string) => boolean | Promise<boolean>;
  private readonly heldLeases = new Map<string, HeldLease>();

  constructor(options: FileSessionStoreOptions = {}) {
    this.home = options.home;
    this.explicitRoot = options.sessionsRoot;
    this.ownerId = options.ownerId ?? crypto.randomUUID();
    this.now = options.now ?? (() => new Date().toISOString());
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
  }

  async list(options: { projectKey?: string; includeAllProjects?: boolean } = {}): Promise<SessionSummary[]> {
    const root = await this.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.match(/^[0-9a-f-]+$/)) continue;
      let id: string;
      try {
        id = normalizeSessionId(entry.name);
      } catch {
        continue;
      }
      const dir = sessionDirectory(root, id);
      const loaded = await this.loadLatestFromDir(dir, id);
      if (!loaded.ok) {
        summaries.push(corruptSummary(id, loaded.health));
        continue;
      }
      const record = loaded.record;
      if (!options.includeAllProjects && options.projectKey && record.workspace.projectKey !== options.projectKey) {
        continue;
      }
      summaries.push(toSummary(record, await this.deriveHealth(dir, record)));
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return summaries;
  }

  async load(id: string): Promise<SessionRecord> {
    const root = await this.root();
    const sessionId = normalizeSessionId(id);
    const dir = sessionDirectory(root, sessionId);
    const loaded = await this.loadLatestFromDir(dir, sessionId);
    if (!loaded.ok) {
      throw new SessionError(loaded.code, loaded.message);
    }
    return loaded.record;
  }

  async acquire(id: string, options: { create?: boolean; force?: boolean } = {}): Promise<SessionLease> {
    const root = await this.root();
    const sessionId = normalizeSessionId(id);
    const dir = sessionDirectory(root, sessionId);
    const held = this.heldLeases.get(sessionId);
    if (held && !held.lease.released) {
      held.refs++;
      return held.lease;
    }

    if (options.create) {
      await mkdir(dir, { recursive: false, mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new SessionError("SESSION_REVISION_CONFLICT", `Session ${sessionId} already exists.`);
        }
        throw error;
      });
    } else {
      await access(dir, constants.R_OK | constants.W_OK).catch(() => {
        throw new SessionError("SESSION_NOT_FOUND", `Session ${sessionId} was not found.`);
      });
    }

    const current = await this.loadLatestFromDir(dir, sessionId);
    if (!options.create && !current.ok) {
      throw new SessionError(current.code, current.message);
    }

    const leasePath = path.join(dir, "lease.json");
    const leasePayload: LeasePayload = {
      sessionId,
      ownerId: this.ownerId,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt: this.now(),
      heartbeatAt: this.now(),
    };
    await this.writeNewLease(leasePath, leasePayload, options.force ?? false);

    const lease: FileSessionLease = {
      sessionId,
      ownerId: this.ownerId,
      revision: current.ok ? current.record.revision : 0,
      dir,
      leasePath,
      heartbeatTimer: null,
      heartbeatTask: null,
      released: false,
      release: async () => {
        await this.releaseLease(lease);
      },
    };
    lease.heartbeatTimer = this.startHeartbeat(lease, leasePayload);
    this.heldLeases.set(sessionId, { lease, refs: 1 });
    return lease;
  }

  async commit(lease: SessionLease, expectedRevision: number, next: SessionRecord): Promise<CommitOutcome> {
    const fileLease = this.asFileLease(lease);
    await this.commitRevision(fileLease, expectedRevision, next);
    const warnings = await this.cleanupOldRevisions(fileLease.dir, next.revision);
    return { committed: true, revision: next.revision, warnings };
  }

  async commitClear(lease: SessionLease, expectedRevision: number, next: SessionRecord): Promise<CommitOutcome> {
    const fileLease = this.asFileLease(lease);
    if (next.messages.length !== 0) {
      throw new SessionError("INVALID_SESSION_RECORD", "Clear commits must persist an empty transcript.");
    }
    await this.writeClearIntent(fileLease, expectedRevision + 1, next);
    await this.commitRevision(fileLease, expectedRevision, next);
    const warnings = await this.cleanupAfterClear(fileLease.dir, next.revision);
    await unlink(path.join(fileLease.dir, "clear.intent")).catch(() => {});
    return { committed: true, revision: next.revision, warnings };
  }

  private async commitRevision(
    fileLease: FileSessionLease,
    expectedRevision: number,
    next: SessionRecord,
  ): Promise<void> {
    await this.assertLease(fileLease);
    const current = await this.loadLatestFromDir(fileLease.dir, fileLease.sessionId);
    const currentRevision = current.ok ? current.record.revision : 0;
    if (currentRevision !== expectedRevision) {
      throw new SessionError(
        "SESSION_REVISION_CONFLICT",
        `Expected revision ${expectedRevision}, found ${currentRevision}.`,
      );
    }
    if (next.id !== fileLease.sessionId || next.revision !== expectedRevision + 1) {
      throw new SessionError("INVALID_SESSION_RECORD", "Committed record id/revision does not match the lease.");
    }

    const target = path.join(fileLease.dir, revisionFilename(next.revision));
    const tmp = path.join(fileLease.dir, `.${next.revision.toString().padStart(16, "0")}.${crypto.randomUUID()}.tmp`);
    const content = `${JSON.stringify(next, stableJsonReplacer, 2)}\n`;
    const handle = await open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    const verified = await this.readRevision(target, fileLease.sessionId, next.revision);
    if (verified.revision !== next.revision) {
      throw new SessionError("SESSION_SAVE_FAILED", "Committed session revision could not be verified.");
    }
    fileLease.revision = next.revision;
  }

  async delete(lease: SessionLease, id: string): Promise<void> {
    const fileLease = this.asFileLease(lease);
    await this.assertLease(fileLease);
    const sessionId = normalizeSessionId(id);
    if (sessionId !== fileLease.sessionId) {
      throw new SessionError("INVALID_SESSION_ID", "Lease does not target the requested session.");
    }
    const root = await this.root();
    const deleting = path.join(root, `.deleting-${sessionId}-${crypto.randomUUID()}`);
    await rename(fileLease.dir, deleting);
    await rm(deleting, { recursive: true, force: true });
  }

  private async root() {
    return this.explicitRoot ? path.resolve(this.explicitRoot) : ensureSessionsRoot(this.home);
  }

  private async loadLatestFromDir(
    dir: string,
    sessionId: string,
  ): Promise<
    | { ok: true; record: SessionRecord }
    | {
        ok: false;
        health: SessionHealth;
        code: "SESSION_NOT_FOUND" | "SESSION_CORRUPTED" | "SESSION_PERSISTENCE_BLOCKED";
        message: string;
      }
  > {
    const files = await readdir(dir).catch(() => null);
    if (!files)
      return {
        ok: false,
        health: "corrupted",
        code: "SESSION_NOT_FOUND",
        message: `Session ${sessionId} was not found.`,
      };
    const revisions = files
      .map((name) => ({ name, revision: parseRevisionFilename(name) }))
      .filter((entry): entry is { name: string; revision: number } => entry.revision !== null)
      .sort((left, right) => right.revision - left.revision);
    if (files.includes("clear.intent") && !(await this.hasCompletedClearRevision(dir, sessionId, revisions))) {
      return {
        ok: false,
        health: "clear_pending",
        code: "SESSION_PERSISTENCE_BLOCKED",
        message: `Session ${sessionId} has an unfinished clear operation. Run clear recovery before resuming it.`,
      };
    }
    if (revisions.length === 0) {
      return {
        ok: false,
        health: "corrupted",
        code: "SESSION_CORRUPTED",
        message: `Session ${sessionId} has no valid revisions.`,
      };
    }

    for (const candidate of revisions) {
      try {
        return {
          ok: true,
          record: await this.readRevision(path.join(dir, candidate.name), sessionId, candidate.revision),
        };
      } catch {
        // 继续尝试更早的候选。
      }
    }
    return {
      ok: false,
      health: "corrupted",
      code: "SESSION_CORRUPTED",
      message: `Session ${sessionId} has no parseable revisions.`,
    };
  }

  private async readRevision(file: string, sessionId: string, revision: number): Promise<SessionRecord> {
    const root = await this.root();
    if (!isPathInside(root, file)) {
      throw new SessionError("INVALID_SESSION_ID", "Revision path resolved outside the sessions directory.");
    }
    const info = await stat(file);
    if (info.size > MAX_RECORD_BYTES) {
      throw new SessionError("SESSION_RECORD_TOO_LARGE", "Session record is too large to load.");
    }
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    const record = parseSessionRecord(parsed);
    if (record.id !== sessionId || record.revision !== revision) {
      throw new SessionError("SESSION_CORRUPTED", "Session revision id or revision number does not match its path.");
    }
    return record;
  }

  private async assertLease(lease: FileSessionLease): Promise<void> {
    const raw = await readFile(lease.leasePath, "utf8").catch(() => null);
    if (!raw) {
      throw new SessionError("SESSION_LOCKED", "Session lease is no longer held.");
    }
    let parsed: { ownerId?: unknown; sessionId?: unknown };
    try {
      parsed = JSON.parse(raw) as { ownerId?: unknown; sessionId?: unknown };
    } catch {
      throw new SessionError("SESSION_LOCKED", "Session lease could not be verified.");
    }
    if (parsed.ownerId !== lease.ownerId || parsed.sessionId !== lease.sessionId) {
      throw new SessionError("SESSION_LOCKED", "Session lease is held by another writer.");
    }
  }

  private async releaseLease(lease: FileSessionLease): Promise<void> {
    const held = this.heldLeases.get(lease.sessionId);
    if (held?.lease === lease && held.refs > 1) {
      held.refs--;
      return;
    }
    if (held?.lease === lease) {
      this.heldLeases.delete(lease.sessionId);
    }
    if (lease.released) return;
    lease.released = true;
    if (lease.heartbeatTimer) {
      clearInterval(lease.heartbeatTimer);
      lease.heartbeatTimer = null;
    }
    await lease.heartbeatTask?.catch(() => {});
    const raw = await readFile(lease.leasePath, "utf8").catch(() => null);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { ownerId?: unknown };
      if (parsed.ownerId === lease.ownerId) {
        await unlink(lease.leasePath).catch(() => {});
      }
    } catch {
      // 内容含糊的 lease 保留原位，交由显式的恢复流程处理。
    }
  }

  private async writeNewLease(leasePath: string, payload: LeasePayload, force: boolean): Promise<void> {
    const write = async (flags: "w" | "wx") => {
      const handle = await open(leasePath, flags);
      try {
        await handle.writeFile(`${JSON.stringify(payload, stableJsonReplacer, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };

    if (force) {
      await write("w");
      return;
    }

    try {
      await write("wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const cleared = await this.tryClearStaleLease(leasePath);
      if (!cleared) {
        throw new SessionError("SESSION_LOCKED", `Session ${payload.sessionId} is already open in another writer.`);
      }
      await write("wx");
    }
  }

  private startHeartbeat(lease: FileSessionLease, payload: LeasePayload): ReturnType<typeof setInterval> | null {
    if (this.heartbeatIntervalMs <= 0) return null;
    const timer = setInterval(() => {
      if (lease.heartbeatTask) return;
      const heartbeatTask = this.refreshHeartbeat(lease, payload);
      lease.heartbeatTask = heartbeatTask;
      void heartbeatTask.catch(() => {}).finally(() => {
        if (lease.heartbeatTask === heartbeatTask) lease.heartbeatTask = null;
      });
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    return timer;
  }

  private async refreshHeartbeat(lease: FileSessionLease, payload: LeasePayload): Promise<void> {
    if (lease.released) return;
    await this.assertLease(lease);
    const next: LeasePayload = { ...payload, heartbeatAt: this.now() };
    const handle = await open(lease.leasePath, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(`${JSON.stringify(next, stableJsonReplacer, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    payload.heartbeatAt = next.heartbeatAt;
  }

  private async tryClearStaleLease(leasePath: string): Promise<boolean> {
    const first = await readLeasePayload(leasePath).catch(() => null);
    if (!first) return false;
    if (first.hostname !== os.hostname()) return false;
    if (await this.processAlive(first.pid, first.hostname)) return false;
    const second = await readLeasePayload(leasePath).catch(() => null);
    if (!second || second.ownerId !== first.ownerId || second.sessionId !== first.sessionId) return false;
    await unlink(leasePath).catch(() => {});
    return !(await exists(leasePath));
  }

  private asFileLease(lease: SessionLease): FileSessionLease {
    if (!("dir" in lease) || !("leasePath" in lease)) {
      throw new SessionError("SESSION_LOCKED", "Lease was not created by FileSessionStore.");
    }
    return lease as FileSessionLease;
  }

  private async deriveHealth(dir: string, record: SessionRecord): Promise<SessionHealth> {
    if (await exists(path.join(dir, "lease.json"))) return "locked";
    if ((await exists(path.join(dir, "clear.intent"))) && record.messages.length > 0) return "clear_pending";
    return (await directoryExists(record.workspace.cwd)) ? "ready" : "cwd_missing";
  }

  private async writeClearIntent(lease: FileSessionLease, targetRevision: number, next: SessionRecord): Promise<void> {
    await this.assertLease(lease);
    const intent = {
      sessionId: lease.sessionId,
      ownerId: lease.ownerId,
      targetRevision,
      createdAt: this.now(),
      retained: {
        id: next.id,
        name: next.name,
        workspace: next.workspace,
        activeAgentGroupId: next.activeAgentGroupId,
        activeAgentId: next.activeAgentId,
      },
    };
    const handle = await open(path.join(lease.dir, "clear.intent"), "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(intent, stableJsonReplacer, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async cleanupAfterClear(dir: string, latestRevision: number): Promise<PublicMaintenanceWarning[]> {
    const warnings: PublicMaintenanceWarning[] = [];
    const files = await readdir(dir).catch(() => []);
    for (const name of files) {
      const revision = parseRevisionFilename(name);
      if (revision === null || revision === latestRevision) continue;
      await rm(path.join(dir, name), { force: true }).catch((error: unknown) => {
        warnings.push({
          code: "CLEAR_CLEANUP_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return warnings;
  }

  private async cleanupOldRevisions(dir: string, latestRevision: number): Promise<PublicMaintenanceWarning[]> {
    const warnings: PublicMaintenanceWarning[] = [];
    const keep = new Set([latestRevision, latestRevision - 1].filter((revision) => revision > 0));
    const files = await readdir(dir).catch(() => []);
    for (const name of files) {
      const revision = parseRevisionFilename(name);
      if (revision === null || keep.has(revision)) continue;
      await rm(path.join(dir, name), { force: true }).catch((error: unknown) => {
        warnings.push({
          code: "RETENTION_CLEANUP_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return warnings;
  }

  private async hasCompletedClearRevision(
    dir: string,
    sessionId: string,
    revisions: Array<{ name: string; revision: number }>,
  ): Promise<boolean> {
    for (const candidate of revisions) {
      try {
        const record = await this.readRevision(path.join(dir, candidate.name), sessionId, candidate.revision);
        if (record.messages.length === 0) return true;
      } catch {
        // 继续向前找更早的候选；当所有候选都无法读取时，由常规的
        // list/load 处理上报损坏。
      }
    }
    return false;
  }
}

function toSummary(record: SessionRecord, health: SessionHealth): SessionSummary {
  return {
    id: record.id,
    shortId: shortSessionId(record.id),
    revision: record.revision,
    name: record.name,
    displayName: displaySessionName(record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    workspace: { ...record.workspace },
    activeAgentGroupId: record.activeAgentGroupId,
    activeAgentId: record.activeAgentId,
    agentModelOverrides: { ...record.agentModelOverrides },
    health,
    messageCount: record.messages.length,
    turnCount: record.turns.length,
  };
}

function corruptSummary(id: string, health: SessionHealth): SessionSummary {
  return {
    id,
    shortId: shortSessionId(id),
    revision: 0,
    name: null,
    displayName: `${shortSessionId(id)} · corrupted`,
    createdAt: "",
    updatedAt: "",
    workspace: { cwd: "", projectKey: "" },
    activeAgentGroupId: "missing",
    activeAgentId: "code",
    agentModelOverrides: {},
    health,
    messageCount: 0,
    turnCount: 0,
  };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function directoryExists(file: string): Promise<boolean> {
  return stat(file).then(
    (info) => info.isDirectory(),
    () => false,
  );
}

async function readLeasePayload(file: string): Promise<LeasePayload> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<LeasePayload>;
  if (
    typeof parsed.sessionId !== "string" ||
    typeof parsed.ownerId !== "string" ||
    typeof parsed.pid !== "number" ||
    typeof parsed.hostname !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.heartbeatAt !== "string"
  ) {
    throw new SessionError("SESSION_LOCKED", "Session lease could not be verified.");
  }
  return parsed as LeasePayload;
}

function defaultProcessAlive(pid: number, hostname: string): boolean {
  if (hostname !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function stableJsonReplacer(_key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)),
  );
}
