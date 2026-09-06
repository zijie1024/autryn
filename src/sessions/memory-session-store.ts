import { SessionError } from "./errors";
import { SessionMutationQueue } from "./session-mutation-queue";
import { assertSessionRecord, displaySessionName, shortSessionId } from "./session-schema";
import type { CommitOutcome, SessionLease, SessionRecord, SessionStore, SessionSummary } from "./session-types";

export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly locks = new Map<string, { ownerId: string; refs: number; lease: SessionLease }>();
  private readonly mutationQueue = new SessionMutationQueue();

  constructor(records: SessionRecord[] = []) {
    for (const record of records) {
      const validated = assertSessionRecord(record);
      this.records.set(validated.id, structuredClone(validated));
    }
  }

  async list(options: { projectKey?: string; includeAllProjects?: boolean } = {}): Promise<SessionSummary[]> {
    const summaries = [...this.records.values()]
      .filter(
        (record) =>
          options.includeAllProjects || !options.projectKey || record.workspace.projectKey === options.projectKey,
      )
      .map((record): SessionSummary => toSummary(record, this.locks.has(record.id) ? "locked" : "ready"))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return structuredClone(summaries);
  }

  async load(id: string): Promise<SessionRecord> {
    const record = this.records.get(id);
    if (!record) throw new SessionError("SESSION_NOT_FOUND", `Session ${id} was not found.`);
    return structuredClone(record);
  }

  async create(record: SessionRecord): Promise<SessionRecord> {
    return this.mutationQueue.run(record.id, async () => {
      const lease = await this.acquire(record.id, { create: true });
      try {
        await this.commit(lease, 0, record);
        return structuredClone(record);
      } finally {
        await lease.release();
      }
    });
  }

  async mutate(
    id: string,
    reducer: (current: SessionRecord) => SessionRecord | null,
    options: { operation?: "commit" | "clear" } = {},
  ): Promise<SessionRecord> {
    return this.mutationQueue.run(id, async () => {
      const lease = await this.acquire(id);
      try {
        const current = await this.load(id);
        const next = reducer(current);
        if (next === null) return current;
        if (options.operation === "clear" && next.messages.length !== 0) {
          throw new SessionError("INVALID_SESSION_RECORD", "Clear commits must persist an empty transcript.");
        }
        await this.commit(lease, current.revision, next);
        return next;
      } finally {
        await lease.release();
      }
    });
  }

  async acquire(id: string, options: { create?: boolean } = {}): Promise<SessionLease> {
    if (!this.records.has(id) && !options.create) {
      throw new SessionError("SESSION_NOT_FOUND", `Session ${id} was not found.`);
    }
    const held = this.locks.get(id);
    if (held) {
      held.refs++;
      return held.lease;
    }
    const ownerId = crypto.randomUUID();
    const lease: SessionLease = {
      sessionId: id,
      ownerId,
      revision: this.records.get(id)?.revision ?? 0,
      release: async () => {
        const current = this.locks.get(id);
        if (current?.ownerId !== ownerId) return;
        if (current.refs > 1) {
          current.refs--;
        } else {
          this.locks.delete(id);
        }
      },
    };
    this.locks.set(id, { ownerId, refs: 1, lease });
    return lease;
  }

  private async commit(lease: SessionLease, expectedRevision: number, next: SessionRecord): Promise<CommitOutcome> {
    this.assertLease(lease);
    const current = this.records.get(lease.sessionId);
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== expectedRevision) {
      throw new SessionError(
        "SESSION_REVISION_CONFLICT",
        `Expected revision ${expectedRevision}, found ${currentRevision}.`,
      );
    }
    if (next.id !== lease.sessionId) {
      throw new SessionError("INVALID_SESSION_RECORD", "Committed record id does not match the lease.");
    }
    const validated = assertSessionRecord(next);
    if (validated.revision !== expectedRevision + 1) {
      throw new SessionError("INVALID_SESSION_RECORD", "Committed record revision must increment by one.");
    }
    this.records.set(lease.sessionId, structuredClone(validated));
    lease.revision = validated.revision;
    return { committed: true, revision: validated.revision, warnings: [] };
  }

  private async delete(lease: SessionLease, id: string): Promise<void> {
    this.assertLease(lease);
    if (lease.sessionId !== id) {
      throw new SessionError("INVALID_SESSION_ID", "Lease does not target the requested session.");
    }
    this.records.delete(id);
    this.locks.delete(id);
  }

  async deleteSession(id: string): Promise<void> {
    await this.mutationQueue.run(id, async () => {
      const lease = await this.acquire(id);
      try {
        await this.delete(lease, id);
      } finally {
        await lease.release().catch(() => {});
      }
    });
  }

  private assertLease(lease: SessionLease) {
    if (this.locks.get(lease.sessionId)?.ownerId !== lease.ownerId) {
      throw new SessionError("SESSION_LOCKED", "Session lease is not held by this writer.");
    }
  }
}

function toSummary(record: SessionRecord, health: SessionSummary["health"]): SessionSummary {
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
