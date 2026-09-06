import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MEMORY_LIMITS, isIndexReference } from "../defaults";
import { MemoryError } from "../domain/errors";
import { sha256Hex } from "../domain/hashing";
import type {
  MemoryDocument,
  MemoryDocumentReference,
  MemoryDocumentSummary,
  MemoryScopeSnapshot,
} from "../domain/memory-document";
import { planMutation, type ExistingDocument } from "../domain/memory-mutation";
import type { FileMemoryScopeMetadata, MemoryScope } from "../domain/memory-scope";
import { isGlobalMemoryScope, isProjectMemoryScope, memoryScopeId } from "../domain/memory-scope";
import type { MemoryCommitRequest, MemoryCommitResult, MemoryStore } from "../ports/memory-store";

import { FileMemoryLock } from "./file-memory-lock";
import {
  scopeLockPath,
  scopeDocumentPath,
  scopeRoot,
  parseReference,
  scopeMetadataPath,
} from "./file-memory-paths";

export interface FileMemoryStoreOptions {
  /** Memory 根目录（通常为 `AUTRYN_HOME`）。Store 不隐式读取环境变量。 */
  home: string;
  clock?: () => string;
  hostname?: string;
  pid?: number;
}

interface LoadedDocument extends ExistingDocument {
  sizeBytes: number;
  updatedAt: string;
}

export class FileMemoryStore implements MemoryStore {
  private readonly home: string;
  private readonly clock: () => string;
  private readonly lock: FileMemoryLock;
  private readonly mutationQueues = new Map<string, Promise<unknown>>();

  constructor(options: FileMemoryStoreOptions) {
    this.home = path.resolve(options.home);
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.lock = new FileMemoryLock({ hostname: options.hostname, pid: options.pid });
  }

  async inspect(scope: MemoryScope): Promise<MemoryScopeSnapshot> {
    this.assertScope(scope);
    await this.assertScopePathSafe(scope);
    const documents = await this.loadDocuments(scope);
    return {
      scope,
      materialized: await this.scopeMetadataExists(scope),
      documents: documents.map(toSummary),
      totalBytes: documents.reduce((total, doc) => total + doc.sizeBytes, 0),
    };
  }

  async list(scope: MemoryScope): Promise<MemoryDocumentSummary[]> {
    this.assertScope(scope);
    await this.assertScopePathSafe(scope);
    return (await this.loadDocuments(scope)).map(toSummary);
  }

  async read(scope: MemoryScope, reference: MemoryDocumentReference): Promise<MemoryDocument | null> {
    this.assertScope(scope);
    parseReference(reference);
    await this.assertScopePathSafe(scope);
    const doc = await this.readDocument(scope, reference);
    return doc ? toDocument(scope, doc) : null;
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    this.assertScope(request.scope);
    return this.enqueueMutation(request.scope, () => this.commitInner(request));
  }

  private async commitInner(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    const { scope, mutation, expectedDigest } = request;
    this.assertMutationReferences(mutation);

    const root = this.scopeRoot(scope);
    await this.assertScopePathSafe(scope);
    await mkdir(root, { recursive: true });
    const lock = this.scopeLock(scope);
    await this.lock.acquire(lock.path, lock.key);
    try {
      await this.verifyScopeMetadata(scope);

      const documents = await this.loadDocuments(scope);
      const current = new Map(documents.map((doc) => [doc.reference, doc]));
      this.assertExpectedDigest(current, mutation, expectedDigest);

      const planned = planMutation(current, mutation);
      this.assertLimits(current, planned);

      const document = await this.apply(scope, planned);
      await this.writeScopeMetadata(scope);
      return { committed: true, operation: planned.operation, reference: planned.reference, ...(document ? { document } : {}) };
    } finally {
      await this.lock.release(lock.path).catch(() => {});
    }
  }

  private async apply(scope: MemoryScope, planned: ReturnType<typeof planMutation>): Promise<MemoryDocument | undefined> {
    const root = this.scopeRoot(scope);
    switch (planned.operation) {
      case "create":
      case "replace":
      case "insert": {
        await mkdir(root, { recursive: true });
        await this.atomicWrite(scope, root, planned.reference, planned.afterContent!);
        return toDocument(scope, {
          reference: planned.reference,
          content: planned.afterContent!,
          digest: planned.afterDigest!,
          sizeBytes: byteLength(planned.afterContent!),
          updatedAt: this.clock(),
        });
      }
      case "delete": {
        await rm(scopeDocumentPath(this.home, scope, planned.reference), { force: true });
        return undefined;
      }
      case "rename": {
        await mkdir(root, { recursive: true });
        const fromPath = scopeDocumentPath(this.home, scope, planned.from!);
        const toPath = scopeDocumentPath(this.home, scope, planned.reference);
        await rename(fromPath, toPath);
        const doc = await this.readDocument(scope, planned.reference);
        if (!doc) throw new MemoryError("MEMORY_WRITE_FAILED", `Rename of ${planned.from} did not produce ${planned.reference}.`);
        return toDocument(scope, doc);
      }
    }
  }

  private async atomicWrite(scope: MemoryScope, root: string, reference: MemoryDocumentReference, content: string): Promise<void> {
    const target = scopeDocumentPath(this.home, scope, reference);
    const tmp = path.join(root, `.${reference}.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, content, "utf8");
    try {
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async loadDocuments(scope: MemoryScope): Promise<LoadedDocument[]> {
    const root = this.scopeRoot(scope);
    if (!(await this.directoryExists(root))) return [];
    await this.verifyScopeMetadata(scope);

    const entries = await readdir(root, { withFileTypes: true });
    const documents: LoadedDocument[] = [];
    for (const entry of entries) {
      const foldedName = entry.name.toLowerCase();
      if (
        (foldedName === "memory.md" && entry.name !== "MEMORY.md") ||
        (entry.name !== "MEMORY.md" &&
          foldedName !== entry.name &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(foldedName))
      ) {
        throw new MemoryError(
          "MEMORY_REFERENCE_INVALID",
          `Memory reference ${entry.name} collides with the canonical reference name.`,
        );
      }
      let reference: MemoryDocumentReference;
      try {
        reference = parseReference(entry.name);
      } catch {
        // scope.json、锁与临时文件不属于可见 Reference。
        continue;
      }
      const doc = await this.readDocument(scope, reference);
      if (doc) documents.push(doc);
    }
    documents.sort((left, right) => left.reference.localeCompare(right.reference));
    return documents;
  }

  private async readDocument(scope: MemoryScope, reference: MemoryDocumentReference): Promise<LoadedDocument | null> {
    const filePath = scopeDocumentPath(this.home, scope, reference);
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    this.assertRegularFile(reference, stats);
    const content = await readFile(filePath, "utf8");
    return {
      reference,
      content,
      digest: sha256Hex(content),
      sizeBytes: byteLength(content),
      updatedAt: stats.mtime.toISOString(),
    };
  }

  private assertRegularFile(reference: string, stats: { isSymbolicLink(): boolean; isFile(): boolean }): void {
    if (stats.isSymbolicLink()) {
      throw new MemoryError("MEMORY_SYMLINK_REJECTED", `Memory document ${reference} is a symbolic link.`);
    }
    if (!stats.isFile()) {
      throw new MemoryError("MEMORY_REFERENCE_INVALID", `Memory document ${reference} is not a regular file.`);
    }
  }

  private async assertScopePathSafe(scope: MemoryScope): Promise<void> {
    const paths = [
      path.join(this.home, "memory"),
      ...(scope.kind === "project" ? [path.join(this.home, "memory", "projects")] : []),
      this.scopeRoot(scope),
    ];
    for (const candidate of paths) {
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink()) {
          throw new MemoryError("MEMORY_SYMLINK_REJECTED", "The memory scope path contains a symbolic link.");
        }
        if (!stats.isDirectory()) {
          throw new MemoryError("MEMORY_SCOPE_MISMATCH", "The memory scope path contains a non-directory entry.");
        }
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
    }
  }

  private async verifyScopeMetadata(scope: MemoryScope): Promise<void> {
    const metadataPath = this.scopeMetadataPath(scope);
    let stats;
    try {
      stats = await lstat(metadataPath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    this.assertRegularFile("scope.json", stats);
    const raw = await readFile(metadataPath, "utf8");
    let metadata: FileMemoryScopeMetadata;
    try {
      metadata = JSON.parse(raw) as FileMemoryScopeMetadata;
    } catch {
      throw new MemoryError("MEMORY_SCOPE_MISMATCH", "The memory scope metadata is corrupted.");
    }
    if (
      metadata.schemaVersion !== 1 ||
      metadata.kind !== scope.kind ||
      metadata.scopeId !== memoryScopeId(scope) ||
      (isProjectMemoryScope(scope) &&
        (metadata.kind !== "project" ||
          metadata.projectId !== scope.projectId ||
          metadata.projectKey !== scope.projectKey))
    ) {
      throw new MemoryError(
        "MEMORY_SCOPE_MISMATCH",
        `The memory scope directory does not match ${scope.kind} scope.`,
      );
    }
  }

  private async scopeMetadataExists(scope: MemoryScope): Promise<boolean> {
    try {
      const stats = await lstat(this.scopeMetadataPath(scope));
      this.assertRegularFile("scope.json", stats);
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private async writeScopeMetadata(scope: MemoryScope): Promise<void> {
    const root = this.scopeRoot(scope);
    await mkdir(root, { recursive: true });
    const metadataPath = this.scopeMetadataPath(scope);
    let createdAt = this.clock();
    try {
      const existing = JSON.parse(await readFile(metadataPath, "utf8")) as FileMemoryScopeMetadata;
      if (existing.createdAt) createdAt = existing.createdAt;
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const metadata: FileMemoryScopeMetadata = isProjectMemoryScope(scope)
      ? {
          schemaVersion: 1,
          kind: "project",
          scopeId: scope.scopeId,
          projectId: scope.projectId,
          projectKey: scope.projectKey,
          createdAt,
          updatedAt: this.clock(),
        }
      : {
          schemaVersion: 1,
          kind: "global",
          scopeId: "global",
          createdAt,
          updatedAt: this.clock(),
        };
    const tmp = path.join(root, `.scope.json.${crypto.randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    try {
      await rename(tmp, metadataPath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private assertExpectedDigest(
    current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
    mutation: MemoryCommitRequest["mutation"],
    expectedDigest: string | null | undefined,
  ): void {
    if (expectedDigest === undefined) return;
    const reference = mutation.type === "rename" ? mutation.from : mutation.reference;
    const existing = current.get(reference);
    if (mutation.type === "create") {
      if (expectedDigest !== null) {
        throw new MemoryError("MEMORY_REVISION_CONFLICT", `Create of ${reference} must use a null expected digest.`, {
          retryable: true,
        });
      }
      return;
    }
    if (expectedDigest === null) {
      throw new MemoryError("MEMORY_REVISION_CONFLICT", `Update of ${reference} requires the document's current digest.`, {
        retryable: true,
      });
    }
    if (!existing || existing.digest !== expectedDigest) {
      throw new MemoryError(
        "MEMORY_REVISION_CONFLICT",
        `Memory document ${reference} changed since it was read; re-read and retry.`,
        { retryable: true },
      );
    }
  }

  private assertLimits(
    current: ReadonlyMap<MemoryDocumentReference, LoadedDocument>,
    planned: ReturnType<typeof planMutation>,
  ): void {
    if (planned.afterContent !== null && byteLength(planned.afterContent) > DEFAULT_MEMORY_LIMITS.maxDocumentBytes) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", `Memory document ${planned.reference} exceeds the maximum size.`);
    }

    let count = current.size;
    if (planned.operation === "create") count += 1;
    else if (planned.operation === "delete") count -= 1;
    // rename 与 replace/insert 不改变数量。
    if (count > DEFAULT_MEMORY_LIMITS.maxDocumentsPerScope) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", "The memory scope has too many documents.");
    }

    let totalBytes = [...current.values()].reduce((total, doc) => total + doc.sizeBytes, 0);
    if (planned.operation === "create" || planned.operation === "replace" || planned.operation === "insert") {
      const before = planned.operation === "create" ? null : current.get(planned.reference);
      totalBytes = totalBytes - (before?.sizeBytes ?? 0) + byteLength(planned.afterContent!);
    } else if (planned.operation === "delete") {
      totalBytes -= current.get(planned.reference)?.sizeBytes ?? 0;
    }
    if (totalBytes > DEFAULT_MEMORY_LIMITS.maxScopeBytes) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", "The memory scope exceeds its total size limit.");
    }
  }

  private assertMutationReferences(mutation: MemoryCommitRequest["mutation"]): void {
    if (mutation.type === "rename") {
      parseReference(mutation.from);
      parseReference(mutation.to);
    } else {
      parseReference(mutation.reference);
    }
    if (mutation.type === "create" && isIndexReference(mutation.reference) && !mutation.content.trim()) {
      throw new MemoryError("MEMORY_CONTENT_REJECTED", "Refusing to create an empty memory index.");
    }
  }

  private assertScope(scope: MemoryScope): void {
    if (!isProjectMemoryScope(scope) && !isGlobalMemoryScope(scope)) {
      throw new MemoryError("MEMORY_SCOPE_INVALID", "Invalid memory scope.");
    }
  }

  private scopeRoot(scope: MemoryScope): string {
    return scopeRoot(this.home, scope);
  }

  private scopeMetadataPath(scope: MemoryScope): string {
    return scopeMetadataPath(this.home, scope);
  }

  private scopeLock(scope: MemoryScope): { path: string; key: string } {
    return { path: scopeLockPath(this.home, scope), key: `${scope.kind}:${memoryScopeId(scope)}` };
  }

  private async directoryExists(dir: string): Promise<boolean> {
    try {
      return (await lstat(dir)).isDirectory();
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private enqueueMutation<T>(scope: MemoryScope, fn: () => Promise<T>): Promise<T> {
    const key = `${scope.kind}:${memoryScopeId(scope)}`;
    const tail = this.mutationQueues.get(key) ?? Promise.resolve();
    const run = tail.then(fn, fn);
    this.mutationQueues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

function toSummary(doc: LoadedDocument): MemoryDocumentSummary {
  return {
    reference: doc.reference,
    digest: doc.digest,
    sizeBytes: doc.sizeBytes,
    updatedAt: doc.updatedAt,
  };
}

function toDocument(scope: MemoryScope, doc: LoadedDocument): MemoryDocument {
  return {
    scope,
    reference: doc.reference,
    content: doc.content,
    digest: doc.digest,
    sizeBytes: doc.sizeBytes,
    updatedAt: doc.updatedAt,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
