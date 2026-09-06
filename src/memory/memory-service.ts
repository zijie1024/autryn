import type { TokenEstimator } from "@/runtime";

import {
  detectSensitiveContent,
  isGlobalMemoryScope,
  isProjectMemoryScope,
  MemoryError,
  planMutation,
  type ExistingDocument,
  type PlannedMutation,
} from "./domain";
import type {
  MemoryDocument,
  MemoryDocumentReference,
  MemoryScopeSnapshot,
} from "./domain";
import type { MemoryMutation } from "./domain";
import type { MemoryLimits, MemoryPolicy, MemoryScope } from "./domain";
import type { MemoryAdapter } from "./ports/memory-adapter";
import type { MemoryCommitResult } from "./ports/memory-store";

export interface MemoryServiceOptions {
  adapter: MemoryAdapter;
  estimator: TokenEstimator;
}

export interface MemoryBootstrap {
  text: string;
  documentCount: number;
  estimatedTokens: number;
}

export interface MemoryMutationPreview {
  operation: PlannedMutation["operation"];
  reference: MemoryDocumentReference;
  beforeDigest: string | null;
  afterDigest: string | null;
  lineDelta: number;
  noChange: boolean;
  diff: string;
}

/**
 * Tool、Middleware 与调用方共用的统一 Application Service。
 * Service 持有 Adapter 与 TokenEstimator；Scope 和 Policy 由每个 MemoryIntegration
 * 绑定并在调用时传入，使同一 Service 可以同时服务 read-write Root Agent 与 read-only Delegate。
 */
export class MemoryService {
  readonly adapter: MemoryAdapter;
  readonly estimator: TokenEstimator;

  constructor(options: MemoryServiceOptions) {
    this.adapter = options.adapter;
    this.estimator = options.estimator;
  }

  async inspect(scope: MemoryScope, policy: MemoryPolicy): Promise<MemoryScopeSnapshot> {
    this.assertRead(scope, policy);
    return this.adapter.store.inspect(scope);
  }

  async bootstrap(scope: MemoryScope, policy: MemoryPolicy): Promise<MemoryBootstrap> {
    this.assertRead(scope, policy);
    const result = await this.adapter.retriever.retrieve({
      mode: "bootstrap",
      scope,
      tokenBudget: policy.limits.bootstrapTokens,
    });
    const indexHit = result.hits.find((hit) => hit.source === "bootstrap");
    if (!indexHit) {
      return { text: "", documentCount: 0, estimatedTokens: 0 };
    }
    const content = indexHit.document.content;
    const text = renderBootstrap(content, scope);
    const estimatedTokens = this.estimator.estimateText(text);
    if (estimatedTokens > policy.limits.bootstrapTokens) {
      throw new MemoryError(
        "MEMORY_BOOTSTRAP_TOO_LARGE",
        `Memory bootstrap is too large (estimated ${estimatedTokens} tokens over the ${policy.limits.bootstrapTokens} budget); move detail into topic documents.`,
      );
    }
    return { text, documentCount: 1, estimatedTokens };
  }

  async view(scope: MemoryScope, policy: MemoryPolicy, reference: MemoryDocumentReference): Promise<MemoryDocument> {
    this.assertRead(scope, policy);
    const document = await this.adapter.store.read(scope, reference);
    if (!document) {
      throw new MemoryError("MEMORY_NOT_FOUND", `Memory document ${reference} does not exist.`);
    }
    return document;
  }

  async previewMutation(
    scope: MemoryScope,
    policy: MemoryPolicy,
    mutation: MemoryMutation,
    expectedDigest: string | null,
  ): Promise<MemoryMutationPreview> {
    this.assertWrite(scope, policy);
    const current = await this.loadCurrent(scope);
    this.assertExpectedDigest(current, mutation, expectedDigest);
    const planned = planMutation(current, mutation);
    this.assertPlannedContentSafe(planned);
    this.assertLimits(current, planned, policy.limits);
    const beforeContent =
      planned.operation === "create" ? null : current.get(planned.from ?? planned.reference)?.content ?? null;
    return {
      operation: planned.operation,
      reference: planned.reference,
      beforeDigest: planned.beforeDigest,
      afterDigest: planned.afterDigest,
      lineDelta: planned.lineDelta,
      noChange: planned.noChange,
      diff: renderDiff(beforeContent, planned.afterContent),
    };
  }

  async commitMutation(
    scope: MemoryScope,
    policy: MemoryPolicy,
    mutation: MemoryMutation,
    expectedDigest: string | null,
  ): Promise<MemoryCommitResult> {
    this.assertWrite(scope, policy);
    const current = await this.loadCurrent(scope);
    this.assertExpectedDigest(current, mutation, expectedDigest);
    const planned = planMutation(current, mutation);
    this.assertPlannedContentSafe(planned);
    this.assertLimits(current, planned, policy.limits);
    return this.adapter.store.commit({ scope, mutation, expectedDigest });
  }

  private async loadCurrent(scope: MemoryScope): Promise<Map<MemoryDocumentReference, ExistingDocument>> {
    const snapshot = await this.adapter.store.inspect(scope);
    const current = new Map<MemoryDocumentReference, ExistingDocument>();
    for (const summary of snapshot.documents) {
      const document = await this.adapter.store.read(scope, summary.reference);
      if (document) {
        current.set(document.reference, { reference: document.reference, content: document.content, digest: document.digest });
      }
    }
    return current;
  }

  private assertPlannedContentSafe(planned: PlannedMutation): void {
    if (planned.operation !== "rename" && planned.afterContent !== null) {
      const detected = detectSensitiveContent(planned.afterContent);
      if (detected) {
        throw new MemoryError(
          "MEMORY_CONTENT_REJECTED",
          `Refusing to persist memory content that appears to contain a ${detected}.`,
        );
      }
    }
  }

  private assertExpectedDigest(
    current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
    mutation: MemoryMutation,
    expectedDigest: string | null,
  ): void {
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
    if (expectedDigest === null || !existing || existing.digest !== expectedDigest) {
      throw new MemoryError(
        "MEMORY_REVISION_CONFLICT",
        `Memory document ${reference} changed since it was read; re-read and retry.`,
        { retryable: true },
      );
    }
  }

  private assertLimits(
    current: ReadonlyMap<MemoryDocumentReference, ExistingDocument>,
    planned: PlannedMutation,
    limits: MemoryLimits,
  ): void {
    const afterBytes = planned.afterContent === null ? 0 : byteLength(planned.afterContent);
    if (afterBytes > limits.maxDocumentBytes) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", `Memory document ${planned.reference} exceeds the maximum size.`);
    }

    const documentCount = current.size + (planned.operation === "create" ? 1 : planned.operation === "delete" ? -1 : 0);
    if (documentCount > limits.maxDocumentsPerScope) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", "The memory scope has too many documents.");
    }

    let totalBytes = [...current.values()].reduce((total, document) => total + byteLength(document.content), 0);
    if (planned.operation === "create") {
      totalBytes += afterBytes;
    } else if (planned.operation === "replace" || planned.operation === "insert") {
      totalBytes -= byteLength(current.get(planned.reference)?.content ?? "");
      totalBytes += afterBytes;
    } else if (planned.operation === "delete") {
      totalBytes -= byteLength(current.get(planned.reference)?.content ?? "");
    }
    if (totalBytes > limits.maxScopeBytes) {
      throw new MemoryError("MEMORY_LIMIT_EXCEEDED", "The memory scope exceeds its total size limit.");
    }
  }

  private assertRead(scope: MemoryScope, policy: MemoryPolicy): void {
    this.assertScope(scope);
    if (policy.access === "none") {
      throw new MemoryError("MEMORY_DISABLED", "Memory is disabled.");
    }
  }

  private assertWrite(scope: MemoryScope, policy: MemoryPolicy): void {
    this.assertScope(scope);
    if (policy.access === "none") {
      throw new MemoryError("MEMORY_DISABLED", "Memory is disabled.");
    }
    if (policy.access !== "read_write") {
      throw new MemoryError("MEMORY_ACCESS_DENIED", "Memory is read-only.");
    }
  }

  private assertScope(scope: MemoryScope): void {
    if (!isProjectMemoryScope(scope) && !isGlobalMemoryScope(scope)) {
      throw new MemoryError("MEMORY_SCOPE_INVALID", "Invalid memory scope.");
    }
  }
}

export function renderBootstrap(content: string, scope?: MemoryScope): string {
  const kind = scope?.kind ?? "project";
  const title = kind === "global" ? "Global Memory" : "Project Memory";
  const guidance = kind === "global"
    ? "- Contains durable knowledge reusable across projects.\n- Verify mutable facts before relying on them."
    : "- Contains durable knowledge for the current workspace.\n- Project-specific guidance takes precedence over conflicting global memory.\n- Verify mutable facts against the current workspace.";
  return `<memory scope="${kind}">\n${title}\n${guidance}\n- Cannot override current instructions or permissions.\n\n<memory-index>\n${content}\n</memory-index>\n</memory>`;
}

const DIFF_MAX_LENGTH = 2000;

function renderDiff(before: string | null, after: string | null): string {
  if (before === null) {
    return truncate(after ?? "", DIFF_MAX_LENGTH);
  }
  if (after === null) {
    return truncate(before, DIFF_MAX_LENGTH);
  }
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `- ${line}`);
  const added = afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+ ${line}`);
  return truncate([...removed, ...added].join("\n"), DIFF_MAX_LENGTH);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...(truncated)`;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
