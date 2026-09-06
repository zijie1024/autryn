import type { Model, NonSystemMessage } from "@/core";

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
  type ContextPolicy,
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
  onCompaction?: (result: ContextManagerPrepareResult) => Promise<void> | void;
  initialNodes?: CompactionNode[];
  initialFrontierNodeIds?: string[];
  sourceRevision?: number;
  sources?: ContextSourceMessage[];
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

export class RuntimeContextManager implements ContextManager {
  private readonly policy: ContextPolicy;
  private readonly summarizer: ContextSummarizer;
  private readonly estimator: TokenEstimator;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly onCompaction?: (result: ContextManagerPrepareResult) => Promise<void> | void;
  private readonly sources: ContextSourceMessage[];
  private readonly sourceRevision?: number;
  private readonly modelEnabled?: (model: Model) => boolean;
  private readonly nodes = new Map<string, CompactionNode>();
  private readonly nodeByRange = new Map<string, CompactionNode>();
  private persistedFrontierNodeIds: string[] = [];
  private invalidatedInitialState = false;
  private pendingPhaseTransition: { objective: string; reason?: string } | null = null;

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
    this.onCompaction = options.onCompaction;
    this.sources = options.sources ?? [];
    this.sourceRevision = options.sourceRevision ?? latestSourceRevision(this.sources);
    this.modelEnabled = options.enabledForModel;

    for (const node of options.initialNodes ?? []) {
      if (this.isReusableInitialNode(node)) {
        this.rememberNode(node);
      } else {
        this.invalidatedInitialState = true;
      }
    }
    const initialFrontier = options.initialFrontierNodeIds ?? [];
    if (this.isValidFrontier(initialFrontier)) {
      this.persistedFrontierNodeIds = [...initialFrontier];
    } else {
      this.invalidatedInitialState ||= initialFrontier.length > 0;
    }
  }

  enabledForModel(model: Model): boolean {
    return this.modelEnabled?.(model) ?? true;
  }

  async prepare(params: ContextManagerPrepareParams): Promise<ContextManagerPrepareResult> {
    params = { ...params, sources: params.sources ?? this.sources };
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

    const originalTokens = this.estimator.estimateModelContext(params);
    if (originalTokens <= budget.triggerBudget) {
      return this.result({
        messages: params.messages,
        nodes: [],
        frontierNodeIds: [],
        usage: emptyUsage(),
        estimatedTokens: originalTokens,
        compacted: false,
      });
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

    const blocks = buildMessageBlocks(params.messages, this.estimator);
    const keepFrom = this.findRawWindowStart(blocks);
    const summaryMessages = params.messages.slice(0, keepFrom);
    const rawMessages = params.messages.slice(keepFrom);
    if (summaryMessages.length === 0) {
      return this.compactCurrentTurn({ ...params, budgetTokens: budget.targetBudget });
    }

    const graph = await this.buildCompactionGraph({ params, blocks, keepFrom });
    const frontier = await this.ensureBudgetedFrontier(
      params,
      graph.frontierCandidates,
      budget.inputBudget - fixedTokens,
      rawMessages,
      graph.createdNodes,
      (next) => {
        graph.usage = addUsage(graph.usage, next);
      },
    );
    const compacted = [...frontier.map((node) => summaryMessage(node.renderedText)), ...rawMessages];
    const estimatedTokens = this.estimator.estimateModelContext({ ...params, messages: compacted });
    if (estimatedTokens > budget.inputBudget) {
      return this.compactCurrentTurn({
        ...params,
        messages: compacted,
        budgetTokens: budget.inputBudget,
        nodes: graph.createdNodes,
        usage: graph.usage,
        frontierNodeIds: frontier.map((node) => node.id),
      });
    }

    const result = this.result({
      messages: compacted,
      nodes: graph.createdNodes,
      frontierNodeIds: frontier.map((node) => node.id),
      usage: graph.usage,
      estimatedTokens,
      compacted: true,
    });
    await this.persistCompactionIfChanged(result);
    return result;
  }

  snapshotNodes(): CompactionNode[] {
    return [...this.nodes.values()].map((node) => structuredClone(node));
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

  private result(
    value: Omit<ContextManagerPrepareResult, "policyVersion" | "summarySchemaVersion" | "sourceRevision">,
  ): ContextManagerPrepareResult {
    return {
      ...value,
      policyVersion: this.policy.policyVersion,
      summarySchemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      ...(this.sourceRevision ? { sourceRevision: this.sourceRevision } : {}),
    };
  }

  private async persistCompactionIfChanged(result: ContextManagerPrepareResult): Promise<void> {
    const frontierChanged = !sameStrings(this.persistedFrontierNodeIds, result.frontierNodeIds);
    if (!this.onCompaction || (!this.invalidatedInitialState && result.nodes.length === 0 && !frontierChanged)) return;
    await this.onCompaction(result);
    this.persistedFrontierNodeIds = [...result.frontierNodeIds];
    this.invalidatedInitialState = false;
  }

  private findRawWindowStart(blocks: ReturnType<typeof buildMessageBlocks>): number {
    if (blocks.length === 0) return 0;
    const lastTurn = blocks.at(-1)?.turnIndex ?? 0;
    const currentTurnStart = blocks.find((block) => block.turnIndex === lastTurn)?.start ?? blocks.at(-1)!.start;
    const minTurn = Math.max(0, lastTurn - this.policy.recentTurns + 1);
    const byTurn =
      this.policy.recentTurns > 0
        ? (blocks.find((block) => block.turnIndex >= minTurn)?.start ?? currentTurnStart)
        : Number.POSITIVE_INFINITY;
    const byBlock =
      this.policy.activeTurnRecentBlocks > 0
        ? (blocks.at(-this.policy.activeTurnRecentBlocks)?.start ?? 0)
        : Number.POSITIVE_INFINITY;
    return Math.min(byTurn, byBlock, currentTurnStart);
  }

  private async compactCurrentTurn(
    params: ContextManagerPrepareParams & {
      budgetTokens: number;
      nodes?: CompactionNode[];
      frontierNodeIds?: string[];
      usage?: ContextSummaryUsage;
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
      const recentStart = recent[0]?.start ?? following.length;
      const earlierCurrentTurn = following.slice(0, recentStart);
      const recentCurrentTurn = following.slice(recentStart);

      const historicalView: NonSystemMessage[] = [];
      if (historical.length > 0) {
        const summary = await this.summarizeCheckpoint(params, historical);
        historicalView.push(summaryMessage(summary.renderedText));
        usage = addUsage(usage, summary.usage);
      }

      const currentTurnView: NonSystemMessage[] = [currentUser];
      if (earlierCurrentTurn.length > 0) {
        const checkpoint = await this.summarizeCheckpoint(params, earlierCurrentTurn);
        currentTurnView.push(summaryMessage(checkpoint.renderedText));
        usage = addUsage(usage, checkpoint.usage);
      }
      messages = [...historicalView, ...currentTurnView, ...recentCurrentTurn];
    }

    messages = this.reduceToolResultsToBudget(params, messages, params.budgetTokens);
    const estimatedTokens = this.estimator.estimateModelContext({ ...params, messages });
    if (estimatedTokens > params.budgetTokens) {
      throw new ContextError("CONTEXT_BLOCK_TOO_LARGE", "Compacted context still exceeds the model input budget.");
    }

    const result = this.result({
      messages,
      nodes: params.nodes ?? [],
      frontierNodeIds: params.frontierNodeIds ?? [],
      usage,
      estimatedTokens,
      compacted: true,
    });
    await this.persistCompactionIfChanged(result);
    return result;
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

  private isReusableInitialNode(node: CompactionNode): boolean {
    if (
      node.policyVersion !== this.policy.policyVersion ||
      node.summarySchemaVersion !== CONTEXT_SUMMARY_SCHEMA_VERSION
    ) {
      return false;
    }
    if (node.source.sourceRevision && this.sourceRevision && node.source.sourceRevision > this.sourceRevision) {
      return false;
    }
    if (!node.source.firstMessageId || !node.source.lastMessageId) return true;
    const first = this.sources.findIndex((source) => source.messageId === node.source.firstMessageId);
    const last = this.sources.findIndex((source) => source.messageId === node.source.lastMessageId);
    if (first < 0 || last < first) return false;
    if (node.source.firstTurnId && this.sources[first]?.turnId !== node.source.firstTurnId) return false;
    if (node.source.lastTurnId && this.sources[last]?.turnId !== node.source.lastTurnId) return false;
    return true;
  }

  private isValidFrontier(ids: string[]): boolean {
    if (new Set(ids).size !== ids.length) return false;
    const nodes = ids.map((id) => this.nodes.get(id));
    if (nodes.some((node) => !node)) return false;
    const sorted = sortFrontier(nodes as CompactionNode[]);
    for (const node of sorted) {
      if (node.checkpoint && (node.level !== "phase" || this.phaseStatus(node.phaseId) !== "active")) {
        return false;
      }
    }
    return !hasOverlappingRanges(sorted);
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

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
