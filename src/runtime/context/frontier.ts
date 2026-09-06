import type { CompactionNode, ContextCompactionCheckpoint, ContextPhaseState, ContextSourceMessage } from "./types";

export interface FrontierValidationInput {
  checkpoint: ContextCompactionCheckpoint;
  nodes: readonly CompactionNode[] | ReadonlyMap<string, CompactionNode>;
  sources: readonly ContextSourceMessage[];
  phases?: readonly ContextPhaseState[];
  currentSourceRevision?: number;
  expectedPolicyVersion?: string;
  expectedSummarySchemaVersion?: number;
  requireStableAnchors?: boolean;
}

export interface ValidatedFrontier {
  checkpoint: ContextCompactionCheckpoint;
  frontier: CompactionNode[];
  rawTailStart: number;
  reachableNodeIds: Set<string>;
}

/** Fully validate persisted derived state before it becomes a reusable Runtime baseline. */
export function validateFrontier(input: FrontierValidationInput): ValidatedFrontier | null {
  const { checkpoint, sources } = input;
  if (!validCheckpointHeader(input)) return null;

  const nodeById = toNodeMap(input.nodes);
  if (!nodeById) return null;
  const reachableNodeIds = collectReachable(checkpoint.frontierNodeIds, nodeById);
  if (!reachableNodeIds) return null;

  for (const id of reachableNodeIds) {
    const node = nodeById.get(id)!;
    if (node.policyVersion !== checkpoint.policyVersion || node.summarySchemaVersion !== checkpoint.summarySchemaVersion) {
      return null;
    }
    if (
      node.source.sourceRevision !== undefined &&
      input.currentSourceRevision !== undefined &&
      node.source.sourceRevision > input.currentSourceRevision
    ) {
      return null;
    }
    if (node.source.sourceRevision !== undefined && node.source.sourceRevision > checkpoint.sourceRevision) return null;
    if (!validNodeRange(node, sources, input.requireStableAnchors ?? false)) return null;
    if (!validChildren(node, nodeById)) return null;
  }

  const frontier = resolveFrontier(checkpoint.frontierNodeIds, nodeById);
  if (!frontier || !validFrontierRanges(frontier)) return null;
  const phases = effectivePhases(input.phases ?? [], sources);
  if (!phases || !validPhaseState(checkpoint, frontier, reachableNodeIds, nodeById, phases)) return null;
  if (frontierHasAncestorPair(frontier, nodeById)) return null;

  return {
    checkpoint,
    frontier,
    rawTailStart: frontier.length === 0 ? 0 : frontier.at(-1)!.source.lastMessageIndex + 1,
    reachableNodeIds,
  };
}

/** Revalidate only mutable anchors after a full graph validation in this ContextManager instance. */
export function validateFrontierFast(
  input: Omit<FrontierValidationInput, "nodes" | "requireStableAnchors"> & {
    frontier: readonly CompactionNode[];
  },
): ValidatedFrontier | null {
  if (!validCheckpointHeader(input)) return null;
  if (input.frontier.length !== input.checkpoint.frontierNodeIds.length) return null;
  for (let index = 0; index < input.frontier.length; index++) {
    const node = input.frontier[index]!;
    if (node.id !== input.checkpoint.frontierNodeIds[index]) return null;
    if (
      node.policyVersion !== input.checkpoint.policyVersion ||
      node.summarySchemaVersion !== input.checkpoint.summarySchemaVersion ||
      !validNodeRange(node, input.sources, false)
    ) {
      return null;
    }
  }
  if (!validFrontierRanges(input.frontier)) return null;
  const phases = input.phases ?? [];
  if (
    phases.length > 0
      ? !validTopLevelPhaseState(input.checkpoint, input.frontier, phases)
      : !validTopLevelPhaseShape(input.checkpoint, input.frontier, input.sources)
  ) {
    return null;
  }
  return {
    checkpoint: input.checkpoint,
    frontier: [...input.frontier],
    rawTailStart: input.frontier.length === 0 ? 0 : input.frontier.at(-1)!.source.lastMessageIndex + 1,
    reachableNodeIds: new Set(input.frontier.map((node) => node.id)),
  };
}

/** Replace completed Phase checkpoints with their already-persisted non-checkpoint descendants. */
export function expandCompletedPhaseCheckpoints(
  frontierNodeIds: readonly string[],
  nodes: readonly CompactionNode[],
  completedPhaseIds: ReadonlySet<string>,
): string[] | null {
  if (completedPhaseIds.size === 0) return [...frontierNodeIds];
  const nodeById = toNodeMap(nodes);
  if (!nodeById) return null;
  const expanding = new Set<string>();
  const expand = (id: string): string[] | null => {
    const node = nodeById.get(id);
    if (!node) return null;
    if (!node.checkpoint || !node.phaseId || !completedPhaseIds.has(node.phaseId)) return [id];
    if (node.childNodeIds.length === 0 || expanding.has(id)) return null;
    expanding.add(id);
    const result: string[] = [];
    for (const childId of node.childNodeIds) {
      const children = expand(childId);
      if (!children) return null;
      result.push(...children);
    }
    expanding.delete(id);
    return result;
  };

  const expanded: string[] = [];
  for (const id of frontierNodeIds) {
    const ids = expand(id);
    if (!ids) return null;
    expanded.push(...ids);
  }
  const unique = [...new Set(expanded)];
  if (unique.length !== expanded.length) return null;
  unique.sort((left, right) => nodeById.get(left)!.source.firstMessageIndex - nodeById.get(right)!.source.firstMessageIndex);
  const frontier = unique.map((id) => nodeById.get(id)!);
  return validFrontierRanges(frontier) ? unique : null;
}

function validCheckpointHeader(
  input: Pick<
    FrontierValidationInput,
    "checkpoint" | "currentSourceRevision" | "expectedPolicyVersion" | "expectedSummarySchemaVersion"
  >,
): boolean {
  const { checkpoint } = input;
  if (checkpoint.sourceRevision <= 0) return false;
  if (input.currentSourceRevision !== undefined && checkpoint.sourceRevision > input.currentSourceRevision) return false;
  if (checkpoint.policyVersion.length === 0 || checkpoint.summarySchemaVersion <= 0) return false;
  if (input.expectedPolicyVersion !== undefined && checkpoint.policyVersion !== input.expectedPolicyVersion) return false;
  return !(
    input.expectedSummarySchemaVersion !== undefined &&
    checkpoint.summarySchemaVersion !== input.expectedSummarySchemaVersion
  );
}

function effectivePhases(
  phases: readonly ContextPhaseState[],
  sources: readonly ContextSourceMessage[],
): ContextPhaseState[] | null {
  if (phases.length > 0) return [...phases];
  const derived = new Map<string, ContextPhaseState>();
  for (const source of sources) {
    if (!source.phaseId || !source.phaseStatus) continue;
    const existing = derived.get(source.phaseId);
    if (existing && existing.status !== source.phaseStatus) return null;
    if (!existing) {
      derived.set(source.phaseId, {
        id: source.phaseId,
        status: source.phaseStatus,
        startedTurnId: source.turnId,
        ...(source.phaseStatus === "completed" ? { endedTurnId: source.turnId } : {}),
      });
    } else if (source.phaseStatus === "completed") {
      existing.endedTurnId = source.turnId;
    }
  }
  return [...derived.values()];
}

function toNodeMap(
  nodes: readonly CompactionNode[] | ReadonlyMap<string, CompactionNode>,
): Map<string, CompactionNode> | null {
  if (!Array.isArray(nodes)) return new Map(nodes as ReadonlyMap<string, CompactionNode>);
  const list = nodes as readonly CompactionNode[];
  const nodeById = new Map(list.map((node) => [node.id, node]));
  return nodeById.size === list.length ? nodeById : null;
}

function resolveFrontier(ids: readonly string[], nodeById: ReadonlyMap<string, CompactionNode>): CompactionNode[] | null {
  if (new Set(ids).size !== ids.length) return null;
  const frontier = ids.map((id) => nodeById.get(id));
  if (frontier.some((node) => !node)) return null;
  const sorted = [...(frontier as CompactionNode[])].sort(
    (left, right) => left.source.firstMessageIndex - right.source.firstMessageIndex,
  );
  return sorted.every((node, index) => node.id === ids[index]) ? sorted : null;
}

function collectReachable(
  ids: readonly string[],
  nodeById: ReadonlyMap<string, CompactionNode>,
): Set<string> | null {
  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (reachable.has(id)) return true;
    const node = nodeById.get(id);
    if (!node) return false;
    visiting.add(id);
    for (const childId of node.childNodeIds) if (!visit(childId)) return false;
    visiting.delete(id);
    reachable.add(id);
    return true;
  };
  return ids.every(visit) ? reachable : null;
}

function validNodeRange(
  node: CompactionNode,
  sources: readonly ContextSourceMessage[],
  requireStableAnchors: boolean,
): boolean {
  const { firstMessageIndex, lastMessageIndex, firstTurnIndex, lastTurnIndex } = node.source;
  if (
    firstMessageIndex < 0 ||
    lastMessageIndex < firstMessageIndex ||
    firstTurnIndex < 0 ||
    lastTurnIndex < firstTurnIndex
  ) {
    return false;
  }
  // Runtime-only callers may not have durable Session source metadata. In that
  // mode the graph can still be checked structurally by its index ranges; only
  // persisted restore/commit paths require and verify stable source anchors.
  if (sources.length === 0 && !requireStableAnchors) return true;
  if (lastMessageIndex >= sources.length) return false;
  const first = sources[firstMessageIndex];
  const last = sources[lastMessageIndex];
  if (!first || !last || first.turnIndex !== firstTurnIndex || last.turnIndex !== lastTurnIndex) return false;
  if (
    node.level !== "session" &&
    (first.phaseId !== last.phaseId || node.phaseId !== first.phaseId)
  ) {
    return false;
  }
  if (
    requireStableAnchors &&
    (!node.source.firstMessageId || !node.source.lastMessageId || !node.source.firstTurnId || !node.source.lastTurnId)
  ) {
    return false;
  }
  if (node.source.firstMessageId && node.source.firstMessageId !== first.messageId) return false;
  if (node.source.lastMessageId && node.source.lastMessageId !== last.messageId) return false;
  if (node.source.firstTurnId && node.source.firstTurnId !== first.turnId) return false;
  if (node.source.lastTurnId && node.source.lastTurnId !== last.turnId) return false;
  if (sources[firstMessageIndex - 1]?.turnIndex === first.turnIndex) return false;
  if (sources[lastMessageIndex + 1]?.turnIndex === last.turnIndex) return false;
  return true;
}

function validChildren(node: CompactionNode, nodeById: ReadonlyMap<string, CompactionNode>): boolean {
  if (node.level === "turn") return node.childNodeIds.length === 0;
  if (node.childNodeIds.length === 0 || new Set(node.childNodeIds).size !== node.childNodeIds.length) return false;
  const children = node.childNodeIds.map((id) => nodeById.get(id));
  if (children.some((child) => !child)) return false;
  const sorted = [...(children as CompactionNode[])].sort(
    (left, right) => left.source.firstMessageIndex - right.source.firstMessageIndex,
  );
  if (sorted.some((child, index) => child.id !== node.childNodeIds[index])) return false;
  if (
    sorted[0]!.source.firstMessageIndex !== node.source.firstMessageIndex ||
    sorted.at(-1)!.source.lastMessageIndex !== node.source.lastMessageIndex
  ) {
    return false;
  }
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1]!.source.lastMessageIndex + 1 !== sorted[index]!.source.firstMessageIndex) return false;
  }
  if (node.level === "segment" && sorted.some((child) => child.level !== "turn")) return false;
  if (node.level === "phase" && sorted.some((child) => child.phaseId !== node.phaseId)) return false;
  return true;
}

function validFrontierRanges(frontier: readonly CompactionNode[]): boolean {
  if (frontier.length === 0) return true;
  if (frontier[0]!.source.firstMessageIndex !== 0) return false;
  for (let index = 1; index < frontier.length; index++) {
    if (frontier[index - 1]!.source.lastMessageIndex + 1 !== frontier[index]!.source.firstMessageIndex) return false;
  }
  return true;
}

function validPhaseState(
  checkpoint: ContextCompactionCheckpoint,
  frontier: readonly CompactionNode[],
  reachableNodeIds: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, CompactionNode>,
  phases: readonly ContextPhaseState[],
): boolean {
  if (!validTopLevelPhaseState(checkpoint, frontier, phases)) return false;
  const activePhaseIds = new Set(phases.filter((phase) => phase.status === "active").map((phase) => phase.id));
  for (const id of reachableNodeIds) {
    const node = nodeById.get(id)!;
    if (node.checkpoint && (node.level !== "phase" || !node.phaseId || !activePhaseIds.has(node.phaseId))) return false;
    if (node.level === "phase" && node.phaseId && activePhaseIds.has(node.phaseId) && !node.checkpoint) return false;
    if (node.level === "session" && node.phaseId && activePhaseIds.has(node.phaseId)) return false;
    if (node.level === "session" && hasActivePhaseDescendant(node, activePhaseIds, nodeById, new Set())) return false;
  }
  return true;
}

function validTopLevelPhaseState(
  checkpoint: ContextCompactionCheckpoint,
  frontier: readonly CompactionNode[],
  phases: readonly ContextPhaseState[],
): boolean {
  const activePhases = phases.filter((phase) => phase.status === "active");
  if (activePhases.length > 1) return false;
  if ((checkpoint.activePhaseId ?? undefined) !== (activePhases[0]?.id ?? undefined)) return false;
  return frontier.every(
    (node) => !node.checkpoint || (node.level === "phase" && node.phaseId === activePhases[0]?.id),
  );
}

function validTopLevelPhaseShape(
  checkpoint: ContextCompactionCheckpoint,
  frontier: readonly CompactionNode[],
  sources: readonly ContextSourceMessage[],
): boolean {
  const latestSource = sources.at(-1);
  if (latestSource?.phaseStatus) {
    const activePhaseId = latestSource.phaseStatus === "active" ? latestSource.phaseId : undefined;
    if ((checkpoint.activePhaseId ?? undefined) !== activePhaseId) return false;
  }
  return frontier.every(
    (node) =>
      !node.checkpoint ||
      (node.level === "phase" &&
        Boolean(checkpoint.activePhaseId) &&
        node.phaseId === checkpoint.activePhaseId),
  );
}

function hasActivePhaseDescendant(
  node: CompactionNode,
  activePhaseIds: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, CompactionNode>,
  seen: Set<string>,
): boolean {
  if (seen.has(node.id)) return false;
  seen.add(node.id);
  return node.childNodeIds.some((childId) => {
    const child = nodeById.get(childId);
    return Boolean(
      child &&
        ((child.phaseId !== undefined && activePhaseIds.has(child.phaseId)) ||
          hasActivePhaseDescendant(child, activePhaseIds, nodeById, seen)),
    );
  });
}

function frontierHasAncestorPair(
  frontier: readonly CompactionNode[],
  nodeById: ReadonlyMap<string, CompactionNode>,
): boolean {
  for (let left = 0; left < frontier.length; left++) {
    for (let right = left + 1; right < frontier.length; right++) {
      if (
        isAncestor(frontier[left]!, frontier[right]!, nodeById) ||
        isAncestor(frontier[right]!, frontier[left]!, nodeById)
      ) {
        return true;
      }
    }
  }
  return false;
}

function isAncestor(
  left: CompactionNode,
  right: CompactionNode,
  nodeById: ReadonlyMap<string, CompactionNode>,
): boolean {
  const seen = new Set<string>();
  const visit = (node: CompactionNode): boolean => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return node.childNodeIds.some((childId) => {
      if (childId === right.id) return true;
      const child = nodeById.get(childId);
      return child ? visit(child) : false;
    });
  };
  return visit(left);
}
