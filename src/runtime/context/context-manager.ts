import type { Model, NonSystemMessage } from "@/core";

import { validateFrontier, validateFrontierFast } from "./frontier";
import { buildMessageBlocks, reduceToolResultBlock } from "./message-blocks";
import { calculateContextBudget, resolveContextPolicy } from "./policy";
import { ExtractiveContextSummarizer, renderMessagesForSummary } from "./summary";
import { TokenEstimator } from "./token-estimator";
import {
  CONTEXT_SUMMARY_SCHEMA_VERSION,
  ContextError,
  type CompactionNode,
  type ContextManager,
  type ContextManagerPrepareParams,
  type ContextManagerPrepareResult,
  type ContextCompactionCheckpoint,
  type ContextPhaseState,
  type ContextPreparePath,
  type ContextPolicy,
  type ContextRestoreState,
  type ContextStateUpdate,
  type ContextSourceMessage,
  type ContextSummarizer,
  type ContextSummaryUsage,
} from "./types";

export interface RuntimeContextManagerOptions {
  policy?: Partial<ContextPolicy>;
  summarizer?: ContextSummarizer;
  estimator?: TokenEstimator;
  idFactory?: () => string;
  now?: () => string;
  onStateUpdate?: (update: ContextStateUpdate) => Promise<void> | void;
  restoreState?: ContextRestoreState;
  enabledForModel?: (model: Model) => boolean;
  summarizerForModel?: (model: Model) => ContextSummarizer;
}

interface CompactionGraph {
  frontierCandidates: CompactionNode[];
  createdNodes: CompactionNode[];
  usage: ContextSummaryUsage;
}

interface PhaseFrontierEntry {
  node: CompactionNode;
  status?: ContextSourceMessage["phaseStatus"];
}

interface CurrentTurnCheckpoint {
  branchLineageId?: string;
  turnKey: string;
  coveredMessageCount: number;
  renderedText: string;
  estimatedTokens: number;
}

export class RuntimeContextManager implements ContextManager {
  private readonly policy: ContextPolicy;
  private readonly summarizer: ContextSummarizer;
  private readonly estimator: TokenEstimator;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly onStateUpdate?: (update: ContextStateUpdate) => Promise<void> | void;
  private sources: ContextSourceMessage[];
  private sourceRevision?: number;
  private readonly modelEnabled?: (model: Model) => boolean;
  private readonly nodes = new Map<string, CompactionNode>();
  private readonly nodeByRange = new Map<string, CompactionNode>();
  private readonly persistedNodeIds = new Set<string>();
  private frontier: CompactionNode[] = [];
  private invalidatedInitialState = false;
  private pendingPhaseTransition: { objective: string; reason?: string } | null = null;
  private checkpoint: ContextCompactionCheckpoint | null = null;
  private branchLineageId?: string;
  private lastObservedMessageCount = 0;
  private activePhases: ContextPhaseState[];
  private nextPhaseObjective: string | null = null;
  private currentTurnCheckpoint: CurrentTurnCheckpoint | null = null;

  constructor(options: RuntimeContextManagerOptions = {}) {
    this.policy = resolveContextPolicy(options.policy);
    const baseSummarizer = options.summarizer ?? new ExtractiveContextSummarizer();
    this.summarizer = options.summarizerForModel
      ? {
          summarize: (request) => {
            if (!request.model) return baseSummarizer.summarize(request);
            return options.summarizerForModel!(request.model).summarize(request);
          },
        }
      : baseSummarizer;
    this.estimator = options.estimator ?? new TokenEstimator();
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.onStateUpdate = options.onStateUpdate;
    this.sources = [...(options.restoreState?.sources ?? [])];
    this.sourceRevision = options.restoreState?.currentSourceRevision ?? latestSourceRevision(this.sources);
    this.modelEnabled = options.enabledForModel;
    this.activePhases = options.restoreState?.phases.filter((phase) => phase.status === "active") ?? [];
    this.nextPhaseObjective = options.restoreState?.checkpoint.nextPhaseObjective ?? null;

    if (options.restoreState) {
      const restored = validateFrontier({
        checkpoint: options.restoreState.checkpoint,
        nodes: options.restoreState.nodes,
        sources: options.restoreState.sources,
        phases: options.restoreState.phases,
        currentSourceRevision: options.restoreState.currentSourceRevision,
        expectedPolicyVersion: this.policy.policyVersion,
        expectedSummarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
        requireStableAnchors: true,
      });
      if (restored) {
        for (const node of options.restoreState.nodes) {
          this.rememberNode(node);
          this.persistedNodeIds.add(node.id);
        }
        this.checkpoint = restored.checkpoint;
        this.frontier = restored.frontier;
      } else this.invalidatedInitialState = true;
      this.lastObservedMessageCount = options.restoreState.sources.length;
    }
  }

  enabledForModel(model: Model): boolean {
    return this.modelEnabled?.(model) ?? true;
  }

  updateSources(
    sources: readonly ContextSourceMessage[],
    sourceRevision?: number,
    phases?: readonly ContextRestoreState["phases"][number][],
    checkpoint?: ContextCompactionCheckpoint,
  ): void {
    if (sources.length < this.lastObservedMessageCount) this.invalidateRestoreState();
    const currentLast = this.sources.at(-1);
    const matchingLast = currentLast ? sources[this.sources.length - 1] : undefined;
    const appendOnly =
      this.sources.length === 0 ||
      (sources.length >= this.sources.length &&
        currentLast !== undefined &&
        matchingLast !== undefined &&
        matchingLast.messageId === currentLast.messageId &&
        matchingLast.turnId === currentLast.turnId &&
        matchingLast.phaseId === currentLast.phaseId &&
        matchingLast.phaseStatus === currentLast.phaseStatus);
    if (appendOnly) this.sources.push(...sources.slice(this.sources.length));
    else {
      this.invalidateRestoreState();
      this.sources = [...sources];
    }
    if (sourceRevision !== undefined) this.sourceRevision = sourceRevision;
    if (phases) this.activePhases = phases.filter((phase) => phase.status === "active");
    if (checkpoint) this.nextPhaseObjective = checkpoint.nextPhaseObjective ?? null;
    this.lastObservedMessageCount = sources.length;
  }

  async prepare(params: ContextManagerPrepareParams): Promise<ContextManagerPrepareResult> {
    params = { ...params, sources: params.sources ?? this.sources };
    if (params.canonicalAppendOnly === false) {
      this.invalidateRestoreState();
      params = { ...params, sources: [] };
    }
    if (params.branchLineageId) {
      if (this.branchLineageId && params.branchLineageId !== this.branchLineageId) {
        this.invalidateRestoreState();
      }
      this.branchLineageId = params.branchLineageId;
    }
    const capabilities = params.model.capabilities;
    if (!capabilities) {
      throw new ContextError(
        "CONTEXT_WINDOW_UNCONFIGURED",
        "Context window tokens are not configured for the active model.",
      );
    }
    const budget = calculateContextBudget({
      contextWindowTokens: capabilities.contextWindowTokens,
      maxOutputTokens: capabilities.maxOutputTokens,
      policy: this.policy,
    });
    if (budget.inputBudget <= 0) {
      throw new ContextError(
        "CONTEXT_FIXED_BUDGET_EXCEEDED",
        "Context budget is not large enough for model output and safety margin.",
      );
    }

    const fixedTokens = this.estimator.withSafety(
      this.estimator.estimateText(params.prompt) + this.estimator.estimateTools(params.tools),
    );
    if (fixedTokens >= budget.inputBudget) {
      throw new ContextError(
        "CONTEXT_FIXED_BUDGET_EXCEEDED",
        "Prompt and tool definitions exceed the model input budget.",
      );
    }

    let incremental: ContextManagerPrepareResult | null = null;
    try {
      incremental = await this.prepareIncremental(params, budget, fixedTokens);
    } catch (error) {
      if (!(error instanceof ContextError) || error.code !== "CONTEXT_STATE_INVALID") throw error;
      this.invalidateRestoreState();
    }
    if (incremental) return incremental;

    const originalTokens = this.estimator.estimateModelContext(params);
    if (originalTokens <= budget.triggerBudget && this.invalidatedInitialState) {
      const stateUpdate =
        params.canonicalAppendOnly === false
          ? undefined
          : { appendNodes: [], checkpoint: this.createCheckpoint(params, []) };
      const result: ContextManagerPrepareResult = {
        messages: params.messages,
        usage: emptyUsage(),
        estimatedTokens: originalTokens,
        compacted: false,
        path: "rebuild",
        ...(stateUpdate ? { stateUpdate } : {}),
      };
      await this.persistStateUpdate(result, params);
      this.lastObservedMessageCount = params.messages.length;
      return result;
    }
    if (originalTokens <= budget.triggerBudget && !this.invalidatedInitialState) {
      return {
        messages: params.messages,
        usage: emptyUsage(),
        estimatedTokens: originalTokens,
        compacted: false,
        path: "raw",
      };
    }
    return this.compactRawTail(params, budget, fixedTokens, [], 0, "rebuild", originalTokens);
  }

  private async prepareIncremental(
    params: ContextManagerPrepareParams,
    budget: ReturnType<typeof calculateContextBudget>,
    fixedTokens: number,
  ): Promise<ContextManagerPrepareResult | null> {
    if (
      !this.checkpoint ||
      this.checkpoint.frontierNodeIds.length === 0 ||
      this.invalidatedInitialState ||
      params.canonicalAppendOnly === false
    ) {
      return null;
    }
    const sources = params.sources ?? this.sources;
    if (params.messages.length < this.lastObservedMessageCount) {
      this.invalidateRestoreState();
      return null;
    }
    const restored = validateFrontierFast({
      checkpoint: this.checkpoint,
      frontier: this.frontier,
      sources,
      phases: this.activePhases,
      currentSourceRevision: this.sourceRevision,
      expectedPolicyVersion: this.policy.policyVersion,
      expectedSummarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
    });
    if (!restored) {
      this.invalidateRestoreState();
      return null;
    }
    const rawStart = restored.rawTailStart;
    if (rawStart > params.messages.length) {
      this.invalidateRestoreState();
      return null;
    }
    const frontier = [...restored.frontier];
    const rawMessages = params.messages.slice(rawStart);
    const baselineMessages = [...frontier.map((node) => summaryMessage(node.renderedText)), ...rawMessages];
    const baselineTokens = fixedTokens + this.estimator.withSafety(this.estimator.estimateMessages(baselineMessages));
    if (baselineTokens <= budget.triggerBudget) {
      const estimatedTokens = this.estimator.estimateModelContext({ ...params, messages: baselineMessages });
      const result: ContextManagerPrepareResult = {
        messages: baselineMessages,
        usage: emptyUsage(),
        estimatedTokens,
        compacted: true,
        path: "incremental",
        reusedNodeCount: frontier.length,
        createdNodeCount: 0,
        compactedTurnCount: 0,
      };
      this.lastObservedMessageCount = params.messages.length;
      return result;
    }
    return this.compactRawTail(params, budget, fixedTokens, frontier, rawStart, "incremental", baselineTokens);
  }

  private async compactRawTail(
    params: ContextManagerPrepareParams,
    budget: ReturnType<typeof calculateContextBudget>,
    fixedTokens: number,
    stableFrontier: CompactionNode[],
    rawStart: number,
    path: ContextPreparePath,
    baselineTokens: number,
  ): Promise<ContextManagerPrepareResult> {
    const blocks = buildMessageBlocks(params.messages, this.estimator, { start: rawStart, end: params.messages.length });
    const normalProtectedStart = this.normalProtectedStart(params, blocks, rawStart);
    let keepFrom = this.selectCompressionEnd(
      params,
      blocks,
      rawStart,
      normalProtectedStart,
      Math.max(1, baselineTokens - budget.targetBudget),
    );

    if (keepFrom === rawStart && baselineTokens <= budget.inputBudget) {
      const messages = [...stableFrontier.map((node) => summaryMessage(node.renderedText)), ...params.messages.slice(rawStart)];
      const result: ContextManagerPrepareResult = {
        messages,
        usage: emptyUsage(),
        estimatedTokens: this.estimator.estimateModelContext({ ...params, messages }),
        compacted: stableFrontier.length > 0,
        path,
        reusedNodeCount: stableFrontier.length,
        createdNodeCount: 0,
        compactedTurnCount: 0,
      };
      this.lastObservedMessageCount = params.messages.length;
      return result;
    }

    const currentUserIndex = lastUserMessageIndex(params.messages);
    if (keepFrom === rawStart) {
      keepFrom = this.selectCompressionEnd(
        params,
        blocks,
        rawStart,
        currentUserIndex < 0 ? params.messages.length : currentUserIndex,
        Math.max(1, baselineTokens - budget.targetBudget),
      );
    }
    if (keepFrom === rawStart) {
      return this.compactCurrentTurn({
        ...params,
        messages: [...stableFrontier.map((node) => summaryMessage(node.renderedText)), ...params.messages.slice(rawStart)],
        budgetTokens: budget.inputBudget,
        usage: emptyUsage(),
        path,
      });
    }

    const createdNodes = new Map<string, CompactionNode>();
    let usage = emptyUsage();
    const build = async (end: number) => {
      const graph = await this.buildCompactionGraph({ params, blocks, keepFrom: end });
      usage = addUsage(usage, graph.usage);
      for (const node of graph.createdNodes) createdNodes.set(node.id, node);
      const rawMessages = params.messages.slice(end);
      let frontier = sortFrontier([...stableFrontier, ...graph.frontierCandidates]);
      assertContinuousFrontier(frontier);
      const finalized: CompactionNode[] = [];
      frontier = await this.finalizeCompletedPhases(params, frontier, finalized, (next) => {
        usage = addUsage(usage, next);
      });
      for (const node of finalized) createdNodes.set(node.id, node);
      const promoted: CompactionNode[] = [];
      frontier = await this.ensureBudgetedFrontier(
        params,
        frontier,
        budget.targetBudget - fixedTokens,
        rawMessages,
        promoted,
        (next) => {
          usage = addUsage(usage, next);
        },
      );
      for (const node of promoted) createdNodes.set(node.id, node);
      const messages = [...frontier.map((node) => summaryMessage(node.renderedText)), ...rawMessages];
      return { frontier, messages, estimatedTokens: this.estimator.estimateModelContext({ ...params, messages }) };
    };

    let built = await build(keepFrom);
    while (built.estimatedTokens > budget.targetBudget && keepFrom < normalProtectedStart) {
      const alreadySelectedReduction = this.estimatedCompressionReduction(params, blocks, rawStart, keepFrom);
      const nextEnd = this.selectCompressionEnd(
        params,
        blocks,
        rawStart,
        normalProtectedStart,
        alreadySelectedReduction + Math.max(1, built.estimatedTokens - budget.targetBudget),
      );
      if (nextEnd <= keepFrom) break;
      keepFrom = nextEnd;
      built = await build(keepFrom);
    }
    while (built.estimatedTokens > budget.inputBudget && currentUserIndex > keepFrom) {
      const alreadySelectedReduction = this.estimatedCompressionReduction(params, blocks, rawStart, keepFrom);
      const emergencyEnd = this.selectCompressionEnd(
        params,
        blocks,
        rawStart,
        currentUserIndex,
        alreadySelectedReduction + Math.max(1, built.estimatedTokens - budget.targetBudget),
      );
      if (emergencyEnd <= keepFrom) break;
      keepFrom = emergencyEnd;
      built = await build(keepFrom);
    }

    const appendNodes = this.unpersistedNodesForFrontier(built.frontier);
    const checkpoint = this.createCheckpoint(params, built.frontier.map((node) => node.id));
    const stateUpdate =
      params.canonicalAppendOnly !== false &&
      (appendNodes.length > 0 || !sameCheckpoint(this.checkpoint, checkpoint))
        ? { appendNodes, checkpoint }
        : undefined;
    const compactedTurnCount = this.turnCount(params, rawStart, keepFrom);
    if (built.estimatedTokens > budget.inputBudget) {
      return this.compactCurrentTurn({
        ...params,
        messages: built.messages,
        budgetTokens: budget.inputBudget,
        usage,
        path,
        ...(stateUpdate ? { stateUpdate } : {}),
      });
    }

    const result: ContextManagerPrepareResult = {
      messages: built.messages,
      usage,
      estimatedTokens: built.estimatedTokens,
      compacted: true,
      path,
      reusedNodeCount: built.frontier.filter((node) => !createdNodes.has(node.id)).length,
      createdNodeCount: appendNodes.length,
      compactedTurnCount,
      ...(stateUpdate ? { stateUpdate } : {}),
    };
    await this.persistStateUpdate(result, params);
    this.lastObservedMessageCount = params.messages.length;
    return result;
  }

  private normalProtectedStart(
    params: ContextManagerPrepareParams,
    blocks: ReturnType<typeof buildMessageBlocks>,
    rawStart: number,
  ): number {
    const groups = this.rawTurnGroups(params, blocks, rawStart);
    const currentUserIndex = lastUserMessageIndex(params.messages);
    const currentTurnStart = currentUserIndex < 0 ? params.messages.length : currentUserIndex;
    if (groups.length === 0) return currentTurnStart;
    const byTurn =
      this.policy.recentTurns > 0
        ? (groups.slice(-this.policy.recentTurns)[0]?.start ?? currentTurnStart)
        : currentTurnStart;
    const currentTurnBlocks = blocks.filter((block) => block.start >= currentTurnStart);
    const byBlock =
      this.policy.activeTurnRecentBlocks > 0
        ? (currentTurnBlocks.at(-this.policy.activeTurnRecentBlocks)?.start ?? currentTurnStart)
        : currentTurnStart;
    return Math.min(byTurn, byBlock, currentTurnStart);
  }

  private async finalizeCompletedPhases(
    params: ContextManagerPrepareParams,
    frontier: CompactionNode[],
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
  ): Promise<CompactionNode[]> {
    const result: CompactionNode[] = [];
    for (let index = 0; index < frontier.length; ) {
      const first = frontier[index]!;
      if (!first.phaseId || this.phaseStatus(first.phaseId, params.sources) !== "completed") {
        result.push(first);
        index++;
        continue;
      }
      const group: CompactionNode[] = [];
      while (index < frontier.length && frontier[index]!.phaseId === first.phaseId) {
        group.push(frontier[index]!);
        index++;
      }
      if (group.length === 1 && group[0]!.level === "phase" && !group[0]!.checkpoint) {
        result.push(group[0]!);
        continue;
      }
      const children = group.flatMap((node) =>
        node.level === "phase" && !node.checkpoint
          ? node.childNodeIds.map((id) => this.nodes.get(id)!).filter(Boolean)
          : [node],
      );
      result.push(
        await this.createParentNode(
          params,
          "phase",
          children,
          false,
          this.policy.phaseSummaryTargetTokens,
          createdNodes,
          noteUsage,
          first.phaseId,
        ),
      );
    }
    const sorted = sortFrontier(result);
    assertContinuousFrontier(sorted);
    return sorted;
  }

  private selectCompressionEnd(
    params: ContextManagerPrepareParams,
    blocks: ReturnType<typeof buildMessageBlocks>,
    rawStart: number,
    protectedStart: number,
    requiredReduction: number,
  ): number {
    let reduction = 0;
    let end = rawStart;
    for (const group of this.rawTurnGroups(params, blocks, rawStart)) {
      if (group.start !== end || group.end >= protectedStart || group.incomplete) break;
      end = group.end + 1;
      reduction += Math.max(1, group.estimatedTokens - this.policy.turnSummaryTargetTokens);
      if (reduction >= requiredReduction) break;
    }
    return end;
  }

  private rawTurnGroups(
    params: ContextManagerPrepareParams,
    blocks: ReturnType<typeof buildMessageBlocks>,
    rawStart: number,
  ): Array<{ start: number; end: number; turnIndex: number; estimatedTokens: number; incomplete: boolean }> {
    const groups: Array<{ start: number; end: number; turnIndex: number; estimatedTokens: number; incomplete: boolean }> = [];
    for (const block of blocks) {
      if (block.start < rawStart) continue;
      const turnIndex = this.turnIndexFor(params, block.start, block.turnIndex);
      const current = groups.at(-1);
      if (current?.turnIndex === turnIndex) {
        current.end = block.end;
        current.estimatedTokens += block.estimatedTokens;
        current.incomplete ||= block.incomplete;
      } else {
        groups.push({
          start: block.start,
          end: block.end,
          turnIndex,
          estimatedTokens: block.estimatedTokens,
          incomplete: block.incomplete,
        });
      }
    }
    return groups;
  }

  private estimatedCompressionReduction(
    params: ContextManagerPrepareParams,
    blocks: ReturnType<typeof buildMessageBlocks>,
    rawStart: number,
    end: number,
  ): number {
    return this.rawTurnGroups(params, blocks, rawStart)
      .filter((group) => group.end < end)
      .reduce(
        (total, group) => total + Math.max(1, group.estimatedTokens - this.policy.turnSummaryTargetTokens),
        0,
      );
  }

  private turnCount(params: ContextManagerPrepareParams, start: number, end: number): number {
    if (end <= start) return 0;
    const sources = params.sources ?? [];
    if (sources.length >= end) return new Set(sources.slice(start, end).map((source) => source.turnIndex)).size;
    return new Set(buildMessageBlocks(params.messages.slice(start, end), this.estimator).map((block) => block.turnIndex)).size;
  }

  private unpersistedNodesForFrontier(frontier: readonly CompactionNode[]): CompactionNode[] {
    const selected = new Map<string, CompactionNode>();
    const visit = (node: CompactionNode) => {
      if (selected.has(node.id)) return;
      for (const childId of node.childNodeIds) {
        const child = this.nodes.get(childId);
        if (child) visit(child);
      }
      if (!this.persistedNodeIds.has(node.id)) selected.set(node.id, node);
    };
    for (const node of frontier) visit(node);
    return [...selected.values()];
  }

  private createCheckpoint(
    params: ContextManagerPrepareParams,
    frontierNodeIds: string[],
  ): ContextCompactionCheckpoint {
    const activePhaseIds = new Set(this.activePhases.map((phase) => phase.id));
    if (activePhaseIds.size === 0) {
      for (const source of params.sources ?? this.sources) {
        if (source.phaseId && source.phaseStatus === "active") activePhaseIds.add(source.phaseId);
      }
    }
    if (activePhaseIds.size > 1) {
      throw new ContextError("CONTEXT_STATE_INVALID", "Context state contains more than one active Phase.");
    }
    return {
      sourceRevision: this.sourceRevision ?? latestSourceRevision(params.sources ?? this.sources) ?? 1,
      frontierNodeIds,
      policyVersion: this.policy.policyVersion,
      summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      updatedAt: this.now(),
      activePhaseId: [...activePhaseIds][0] ?? null,
      nextPhaseObjective: this.nextPhaseObjective,
    };
  }

  requestPhaseTransition(input: { objective: string; reason?: string }) {
    if (this.pendingPhaseTransition) {
      return {
        ok: false,
        error: "A phase transition has already been requested for this turn.",
        code: "PHASE_TRANSITION_CONFLICT",
      };
    }
    this.pendingPhaseTransition = {
      objective: input.objective.trim(),
      ...(input.reason ? { reason: input.reason.trim() } : {}),
    };
    return { ok: true, summary: `Next phase registered: ${this.pendingPhaseTransition.objective}` };
  }

  consumePendingPhaseTransition(): { objective: string; reason?: string } | null {
    const pending = this.pendingPhaseTransition;
    this.pendingPhaseTransition = null;
    return pending;
  }

  private async persistStateUpdate(
    result: ContextManagerPrepareResult,
    params: ContextManagerPrepareParams,
  ): Promise<void> {
    const update = result.stateUpdate;
    if (!update) return;
    const validated = validateFrontier({
      checkpoint: update.checkpoint,
      nodes: this.nodes,
      sources: params.sources ?? this.sources,
      phases: this.activePhases,
      currentSourceRevision: this.sourceRevision,
      expectedPolicyVersion: this.policy.policyVersion,
      expectedSummarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
    });
    if (!validated) {
      throw new ContextError("CONTEXT_STATE_INVALID", "Context compaction produced an invalid frontier.");
    }
    if (this.onStateUpdate) await this.onStateUpdate(update);
    for (const node of update.appendNodes) this.persistedNodeIds.add(node.id);
    this.checkpoint = structuredClone(update.checkpoint);
    this.frontier = validated.frontier;
    this.invalidatedInitialState = false;
  }

  private invalidateRestoreState(): void {
    this.checkpoint = null;
    this.frontier = [];
    this.nodes.clear();
    this.nodeByRange.clear();
    this.persistedNodeIds.clear();
    this.currentTurnCheckpoint = null;
    this.lastObservedMessageCount = 0;
    this.invalidatedInitialState = true;
  }

  private async compactCurrentTurn(
    params: ContextManagerPrepareParams & {
      budgetTokens: number;
      usage?: ContextSummaryUsage;
      path?: ContextPreparePath;
      stateUpdate?: ContextStateUpdate;
    },
  ): Promise<ContextManagerPrepareResult> {
    const currentUserIndex = lastUserMessageIndex(params.messages);
    let usage = params.usage ?? emptyUsage();
    let messages: NonSystemMessage[];

    if (currentUserIndex < 0) {
      messages = [...params.messages];
    } else {
      const historical = params.messages.slice(0, currentUserIndex);
      const currentUser = params.messages[currentUserIndex]!;
      const following = params.messages.slice(currentUserIndex + 1);
      const followingBlocks = buildMessageBlocks(following, this.estimator);
      const recent =
        this.policy.activeTurnRecentBlocks > 0 ? followingBlocks.slice(-this.policy.activeTurnRecentBlocks) : [];
      const recentBlockStart = recent[0]?.start ?? following.length;
      const earlierCurrentTurn = following.slice(0, recentBlockStart);
      const recentCurrentTurn = following.slice(recentBlockStart);

      const historicalView: NonSystemMessage[] = [...historical];

      const currentTurnView: NonSystemMessage[] = [currentUser];
      if (earlierCurrentTurn.length > 0) {
        const turnKey = this.currentTurnKey(params, currentUser);
        const existing = this.currentTurnCheckpoint;
        if (
          existing &&
          existing.turnKey === turnKey &&
          existing.branchLineageId === params.branchLineageId &&
          existing.coveredMessageCount <= recentBlockStart
        ) {
          if (existing.coveredMessageCount < recentBlockStart) {
            const delta = following.slice(existing.coveredMessageCount, recentBlockStart);
            const next = await this.summarizeCheckpoint(params, [summaryMessage(existing.renderedText), ...delta]);
            existing.renderedText = next.renderedText;
            existing.coveredMessageCount = recentBlockStart;
            existing.estimatedTokens = this.estimator.estimateMessages([summaryMessage(existing.renderedText)]);
            usage = addUsage(usage, next.usage);
          }
          currentTurnView.push(summaryMessage(existing.renderedText));
        } else {
          const checkpoint = await this.summarizeCheckpoint(params, earlierCurrentTurn);
          this.currentTurnCheckpoint = {
            branchLineageId: params.branchLineageId,
            turnKey,
            coveredMessageCount: recentBlockStart,
            renderedText: checkpoint.renderedText,
            estimatedTokens: this.estimator.estimateMessages([summaryMessage(checkpoint.renderedText)]),
          };
          currentTurnView.push(summaryMessage(checkpoint.renderedText));
          usage = addUsage(usage, checkpoint.usage);
        }
      } else {
        this.currentTurnCheckpoint = null;
      }
      messages = [...historicalView, ...currentTurnView, ...recentCurrentTurn];
    }

    messages = this.reduceToolResultsToBudget(params, messages, params.budgetTokens);
    const estimatedTokens = this.estimator.estimateModelContext({ ...params, messages });
    if (estimatedTokens > params.budgetTokens) {
      throw new ContextError("CONTEXT_BLOCK_TOO_LARGE", "Compacted context still exceeds the model input budget.");
    }

    const result: ContextManagerPrepareResult = {
      messages,
      usage,
      estimatedTokens,
      compacted: true,
      path: params.path ?? "rebuild",
      ...(params.stateUpdate ? { stateUpdate: params.stateUpdate } : {}),
    };
    await this.persistStateUpdate(result, params);
    this.lastObservedMessageCount = params.messages.length;
    return result;
  }

  private currentTurnKey(params: ContextManagerPrepareParams, currentUser: NonSystemMessage): string {
    const sourceTurnId = params.sources?.at(-1)?.turnId;
    if (sourceTurnId) return sourceTurnId;
    return `${params.branchLineageId ?? "branch"}:${this.estimator.estimateMessage(currentUser)}`;
  }

  private summarizeCheckpoint(params: ContextManagerPrepareParams, messages: NonSystemMessage[]) {
    return this.summarizer.summarize({
      level: "turn_checkpoint",
      sourceText: renderMessagesForSummary(messages),
      targetTokens: this.policy.turnSummaryTargetTokens,
      policyVersion: this.policy.policyVersion,
      signal: params.signal,
      model: params.model,
    });
  }

  private reduceToolResultsToBudget(
    params: ContextManagerPrepareParams,
    input: NonSystemMessage[],
    budgetTokens: number,
  ): NonSystemMessage[] {
    let messages = input;
    for (let attempt = 0; attempt < 32; attempt++) {
      if (this.estimator.estimateModelContext({ ...params, messages }) <= budgetTokens) return messages;
      const candidate = buildMessageBlocks(messages, this.estimator)
        .filter((block) => block.messages.some((message) => message.role === "tool"))
        .sort((left, right) => right.estimatedTokens - left.estimatedTokens)[0];
      if (!candidate) return messages;
      const largestResult = candidate.messages
        .flatMap((message) => (message.role === "tool" ? message.content.map((content) => content.content.length) : []))
        .sort((left, right) => right - left)[0];
      if (!largestResult || largestResult <= 128) return messages;
      const reduced = reduceToolResultBlock(candidate.messages, Math.max(128, Math.floor(largestResult / 2)));
      if (!reduced) return messages;
      messages = [...messages.slice(0, candidate.start), ...reduced, ...messages.slice(candidate.end + 1)];
    }
    return messages;
  }

  private async buildCompactionGraph(input: {
    params: ContextManagerPrepareParams;
    blocks: ReturnType<typeof buildMessageBlocks>;
    keepFrom: number;
  }): Promise<CompactionGraph> {
    const createdNodes: CompactionNode[] = [];
    let usage = emptyUsage();
    const noteUsage = (next: ContextSummaryUsage) => {
      usage = addUsage(usage, next);
    };
    const turnNodes = await this.buildTurnNodes(input, createdNodes, noteUsage);
    const segmentNodes = await this.buildParentNodes(
      input.params,
      "segment",
      turnNodes,
      this.policy.segmentSourceTargetTokens,
      this.policy.segmentSummaryTargetTokens,
      createdNodes,
      noteUsage,
    );
    const phaseEntries = await this.buildPhaseFrontier(input.params, segmentNodes, createdNodes, noteUsage);
    const activeEntries = phaseEntries.filter((entry) => entry.status === "active");
    const completedEntries = phaseEntries.filter((entry) => entry.status !== "active");
    const completedHistory = await this.buildParentNodes(
      input.params,
      "session",
      completedEntries.map((entry) => entry.node),
      this.policy.segmentSourceTargetTokens * 4,
      this.policy.sessionSummaryTargetTokens,
      createdNodes,
      noteUsage,
    );
    const frontierCandidates = sortFrontier([...completedHistory, ...activeEntries.map((entry) => entry.node)]);
    assertNonOverlapping(frontierCandidates);
    return { frontierCandidates, createdNodes, usage };
  }

  private async buildTurnNodes(
    input: { params: ContextManagerPrepareParams; blocks: ReturnType<typeof buildMessageBlocks>; keepFrom: number },
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
  ): Promise<CompactionNode[]> {
    const groups = this.groupHistoricalTurns(input.params, input.blocks, input.keepFrom);
    const nodes: CompactionNode[] = [];
    for (const group of groups) {
      const sourceMessages = input.params.messages.slice(group.start, group.end + 1);
      const source = this.sourceRange(input.params, group.start, group.end, group.turnIndex, group.turnIndex);
      const existing = this.reusableNode("turn", source, false);
      if (existing) {
        nodes.push(existing);
        continue;
      }
      const node = await this.createNode({
        params: input.params,
        level: "turn",
        source,
        phaseId: input.params.sources?.[group.start]?.phaseId,
        checkpoint: false,
        sourceMessages,
        targetTokens: this.policy.turnSummaryTargetTokens,
        childNodeIds: [],
      });
      nodes.push(node);
      createdNodes.push(node);
      noteUsage(node.generationUsage);
    }
    return nodes;
  }

  private async buildParentNodes(
    params: ContextManagerPrepareParams,
    level: CompactionNode["level"],
    childNodes: CompactionNode[],
    sourceTargetTokens: number,
    targetTokens: number,
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
  ): Promise<CompactionNode[]> {
    if (childNodes.length <= 1) return childNodes;
    const groups: CompactionNode[][] = [];
    let current: CompactionNode[] = [];
    let currentTokens = 0;
    let currentPhaseId: string | undefined;
    for (const node of childNodes) {
      const nextTokens = currentTokens + node.estimatedTokens;
      const crossesPhase = level !== "session" && currentPhaseId && node.phaseId && currentPhaseId !== node.phaseId;
      if (current.length > 0 && (nextTokens >= sourceTargetTokens || crossesPhase)) {
        groups.push(current);
        current = [];
        currentTokens = 0;
        currentPhaseId = undefined;
      }
      current.push(node);
      currentTokens += node.estimatedTokens;
      currentPhaseId = currentPhaseId ?? node.phaseId;
    }
    if (current.length > 0) groups.push(current);

    const parents: CompactionNode[] = [];
    for (const group of groups) {
      if (group.length === 1) {
        parents.push(group[0]!);
        continue;
      }
      parents.push(await this.createParentNode(params, level, group, false, targetTokens, createdNodes, noteUsage));
    }
    return parents;
  }

  private async buildPhaseFrontier(
    params: ContextManagerPrepareParams,
    segmentNodes: CompactionNode[],
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
  ): Promise<PhaseFrontierEntry[]> {
    const groups: Array<{ phaseId?: string; status?: ContextSourceMessage["phaseStatus"]; nodes: CompactionNode[] }> =
      [];
    for (const node of segmentNodes) {
      const status = this.phaseStatus(node.phaseId, params.sources);
      const current = groups.at(-1);
      if (current && current.phaseId === node.phaseId && current.status === status) {
        current.nodes.push(node);
      } else {
        groups.push({
          ...(node.phaseId ? { phaseId: node.phaseId } : {}),
          ...(status ? { status } : {}),
          nodes: [node],
        });
      }
    }

    const entries: PhaseFrontierEntry[] = [];
    for (const group of groups) {
      if (group.status === "completed") {
        const node = await this.createParentNode(
          params,
          "phase",
          group.nodes,
          false,
          this.policy.phaseSummaryTargetTokens,
          createdNodes,
          noteUsage,
          group.phaseId,
        );
        entries.push({ node, status: "completed" });
        continue;
      }
      if (group.status === "active") {
        if (group.nodes.length === 1) {
          entries.push({ node: group.nodes[0]!, status: "active" });
        } else {
          const node = await this.createParentNode(
            params,
            "phase",
            group.nodes,
            true,
            this.policy.phaseSummaryTargetTokens,
            createdNodes,
            noteUsage,
            group.phaseId,
          );
          entries.push({ node, status: "active" });
        }
        continue;
      }

      const legacy = await this.buildParentNodes(
        params,
        "phase",
        group.nodes,
        this.policy.segmentSourceTargetTokens * 2,
        this.policy.phaseSummaryTargetTokens,
        createdNodes,
        noteUsage,
      );
      entries.push(...legacy.map((node) => ({ node })));
    }
    return entries;
  }

  private async createParentNode(
    params: ContextManagerPrepareParams,
    level: CompactionNode["level"],
    children: CompactionNode[],
    checkpoint: boolean,
    targetTokens: number,
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
    phaseId?: string,
  ): Promise<CompactionNode> {
    const source = mergeSources(children);
    const existing = this.reusableNode(level, source, checkpoint);
    if (existing) return existing;
    const resolvedPhaseId =
      phaseId ?? (children.every((child) => child.phaseId === children[0]?.phaseId) ? children[0]?.phaseId : undefined);
    const node = await this.createNode({
      params,
      level,
      source,
      ...(resolvedPhaseId ? { phaseId: resolvedPhaseId } : {}),
      checkpoint,
      sourceText: children.map((child) => child.renderedText).join("\n\n"),
      targetTokens,
      childNodeIds: children.map((child) => child.id),
    });
    createdNodes.push(node);
    noteUsage(node.generationUsage);
    return node;
  }

  private async ensureBudgetedFrontier(
    params: ContextManagerPrepareParams,
    candidates: CompactionNode[],
    availableTokens: number,
    rawMessages: NonSystemMessage[],
    createdNodes: CompactionNode[],
    noteUsage: (usage: ContextSummaryUsage) => void,
  ): Promise<CompactionNode[]> {
    const rawTokens = this.estimator.estimateMessages(rawMessages);
    const summaryTokens = candidates.reduce((total, node) => total + node.estimatedTokens, 0);
    if (summaryTokens + rawTokens <= availableTokens) return candidates;
    if (candidates.length === 0) return [];

    const active = candidates.filter((node) => this.isActivePhaseNode(node, params.sources));
    const completed = candidates.filter((node) => !active.includes(node));
    const frontier: CompactionNode[] = [];
    if (completed.length > 0) {
      frontier.push(
        completed.length === 1 && completed[0]?.level === "session"
          ? completed[0]
          : await this.createParentNode(
              params,
              "session",
              completed,
              false,
              this.policy.sessionSummaryTargetTokens,
              createdNodes,
              noteUsage,
            ),
      );
    }
    if (active.length > 0) {
      const existingCheckpoint = active.length === 1 && active[0]?.level === "phase" && active[0].checkpoint;
      frontier.push(
        existingCheckpoint
          ? active[0]!
          : await this.createParentNode(
              params,
              "phase",
              active,
              true,
              this.policy.phaseSummaryTargetTokens,
              createdNodes,
              noteUsage,
              active[0]?.phaseId,
            ),
      );
    }
    const sorted = sortFrontier(frontier);
    assertNonOverlapping(sorted);
    return sorted;
  }

  private groupHistoricalTurns(
    params: ContextManagerPrepareParams,
    blocks: ReturnType<typeof buildMessageBlocks>,
    keepFrom: number,
  ) {
    const groups: Array<{ turnIndex: number; start: number; end: number }> = [];
    for (const block of blocks) {
      if (block.start >= keepFrom) continue;
      const end = Math.min(block.end, keepFrom - 1);
      const turnIndex = this.turnIndexFor(params, block.start, block.turnIndex);
      const current = groups.at(-1);
      if (current && current.turnIndex === turnIndex) {
        current.end = end;
      } else {
        groups.push({ turnIndex, start: block.start, end });
      }
    }
    return groups;
  }

  private turnIndexFor(params: ContextManagerPrepareParams, messageIndex: number, fallback: number): number {
    return params.sources?.[messageIndex]?.turnIndex ?? fallback;
  }

  private sourceRange(
    params: ContextManagerPrepareParams,
    start: number,
    end: number,
    firstTurnIndex: number,
    lastTurnIndex: number,
  ): CompactionNode["source"] {
    const first = params.sources?.[start];
    const last = params.sources?.[end];
    const sourceRevision = this.sourceRevision ?? last?.sourceRevision;
    return {
      firstMessageIndex: start,
      lastMessageIndex: end,
      firstTurnIndex: first?.turnIndex ?? firstTurnIndex,
      lastTurnIndex: last?.turnIndex ?? lastTurnIndex,
      ...(first?.messageId ? { firstMessageId: first.messageId } : {}),
      ...(last?.messageId ? { lastMessageId: last.messageId } : {}),
      ...(first?.turnId ? { firstTurnId: first.turnId } : {}),
      ...(last?.turnId ? { lastTurnId: last.turnId } : {}),
      ...(sourceRevision ? { sourceRevision } : {}),
    };
  }

  private async createNode(input: {
    params: ContextManagerPrepareParams;
    level: CompactionNode["level"];
    source: CompactionNode["source"];
    phaseId?: string;
    checkpoint: boolean;
    sourceMessages?: NonSystemMessage[];
    sourceText?: string;
    targetTokens: number;
    childNodeIds: string[];
  }): Promise<CompactionNode> {
    const summary = await this.summarizer.summarize({
      level: input.level,
      sourceText: input.sourceText ?? renderMessagesForSummary(input.sourceMessages ?? []),
      targetTokens: input.targetTokens,
      policyVersion: this.policy.policyVersion,
      signal: input.params.signal,
      model: input.params.model,
    });
    const node: CompactionNode = {
      id: this.idFactory(),
      level: input.level,
      ...(input.phaseId ? { phaseId: input.phaseId } : {}),
      checkpoint: input.checkpoint,
      source: input.source,
      childNodeIds: input.childNodeIds,
      summary: summary.summary,
      renderedText: summary.renderedText,
      estimatedTokens: this.estimator.estimateMessages([summaryMessage(summary.renderedText)]),
      summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      policyVersion: this.policy.policyVersion,
      generatedBy: { model: input.params.model.name },
      generationUsage: summary.usage ?? emptyUsage(true),
      createdAt: this.now(),
    };
    this.rememberNode(node);
    return node;
  }

  private reusableNode(
    level: CompactionNode["level"],
    source: CompactionNode["source"],
    checkpoint: boolean,
  ): CompactionNode | undefined {
    const node = this.nodeByRange.get(
      rangeKey(level, source, this.policy.policyVersion, CONTEXT_SUMMARY_SCHEMA_VERSION),
    );
    return node?.checkpoint === checkpoint ? node : undefined;
  }

  private rememberNode(node: CompactionNode): void {
    this.nodes.set(node.id, node);
    this.nodeByRange.set(rangeKey(node.level, node.source, node.policyVersion, node.summarySchemaVersion), node);
  }

  private phaseStatus(
    phaseId: string | undefined,
    sources: ContextSourceMessage[] | undefined = this.sources,
  ): ContextSourceMessage["phaseStatus"] {
    if (!phaseId) return undefined;
    return sources?.find((source) => source.phaseId === phaseId)?.phaseStatus;
  }

  private isActivePhaseNode(node: CompactionNode, sources?: ContextSourceMessage[]): boolean {
    return node.checkpoint || this.phaseStatus(node.phaseId, sources) === "active";
  }
}

function mergeSources(nodes: CompactionNode[]): CompactionNode["source"] {
  const first = nodes[0]!;
  const last = nodes.at(-1)!;
  return {
    firstMessageIndex: first.source.firstMessageIndex,
    lastMessageIndex: last.source.lastMessageIndex,
    firstTurnIndex: first.source.firstTurnIndex,
    lastTurnIndex: last.source.lastTurnIndex,
    ...(first.source.firstMessageId ? { firstMessageId: first.source.firstMessageId } : {}),
    ...(last.source.lastMessageId ? { lastMessageId: last.source.lastMessageId } : {}),
    ...(first.source.firstTurnId ? { firstTurnId: first.source.firstTurnId } : {}),
    ...(last.source.lastTurnId ? { lastTurnId: last.source.lastTurnId } : {}),
    ...(last.source.sourceRevision ? { sourceRevision: last.source.sourceRevision } : {}),
  };
}

function rangeKey(
  level: CompactionNode["level"],
  source: CompactionNode["source"],
  policyVersion: string,
  summarySchemaVersion: number,
): string {
  const stableIds =
    source.firstMessageId && source.lastMessageId && source.firstTurnId && source.lastTurnId
      ? [source.firstMessageId, source.lastMessageId, source.firstTurnId, source.lastTurnId]
      : [
          source.firstMessageIndex,
          source.lastMessageIndex,
          source.firstTurnIndex,
          source.lastTurnIndex,
          source.sourceRevision ?? "",
        ];
  return [level, ...stableIds, policyVersion, summarySchemaVersion].join(":");
}

function summaryMessage(text: string): NonSystemMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

function emptyUsage(incomplete = false): ContextSummaryUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, usageIncomplete: incomplete };
}

function addUsage(a?: ContextSummaryUsage, b?: ContextSummaryUsage): ContextSummaryUsage {
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    usageIncomplete: Boolean(a?.usageIncomplete || b?.usageIncomplete),
  };
}

function latestSourceRevision(sources: ContextSourceMessage[]): number | undefined {
  return sources.reduce<number | undefined>((latest, source) => {
    if (!source.sourceRevision) return latest;
    return Math.max(latest ?? 0, source.sourceRevision);
  }, undefined);
}

function lastUserMessageIndex(messages: readonly NonSystemMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function sortFrontier(nodes: CompactionNode[]): CompactionNode[] {
  return [...nodes].sort((left, right) => left.source.firstMessageIndex - right.source.firstMessageIndex);
}

function hasOverlappingRanges(nodes: CompactionNode[]): boolean {
  for (let index = 1; index < nodes.length; index++) {
    if (nodes[index]!.source.firstMessageIndex <= nodes[index - 1]!.source.lastMessageIndex) return true;
  }
  return false;
}

function assertNonOverlapping(nodes: CompactionNode[]): void {
  if (hasOverlappingRanges(nodes)) {
    throw new ContextError("CONTEXT_STATE_INVALID", "Compaction frontier contains overlapping source ranges.");
  }
}

function assertContinuousFrontier(nodes: CompactionNode[]): void {
  assertNonOverlapping(nodes);
  if (nodes.length === 0 || nodes[0]!.source.firstMessageIndex !== 0) {
    throw new ContextError("CONTEXT_STATE_INVALID", "Compaction frontier does not begin at the transcript start.");
  }
  for (let index = 1; index < nodes.length; index++) {
    if (nodes[index - 1]!.source.lastMessageIndex + 1 !== nodes[index]!.source.firstMessageIndex) {
      throw new ContextError("CONTEXT_STATE_INVALID", "Compaction frontier contains a source gap.");
    }
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCheckpoint(left: ContextCompactionCheckpoint | null, right: ContextCompactionCheckpoint): boolean {
  if (!left) return false;
  return (
    left.sourceRevision === right.sourceRevision &&
    sameStrings(left.frontierNodeIds, right.frontierNodeIds) &&
    (left.activePhaseId ?? null) === (right.activePhaseId ?? null) &&
    (left.nextPhaseObjective ?? null) === (right.nextPhaseObjective ?? null) &&
    left.policyVersion === right.policyVersion &&
    left.summarySchemaVersion === right.summarySchemaVersion
  );
}
