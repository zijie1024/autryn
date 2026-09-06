import type { NonSystemMessage, ToolUseContent } from "@/core";

import { TokenEstimator } from "./token-estimator";
import type { ContextMessageBlock } from "./types";

export function buildMessageBlocks(
  messages: readonly NonSystemMessage[],
  estimator = new TokenEstimator(),
): ContextMessageBlock[] {
  const blocks: ContextMessageBlock[] = [];
  let turnIndex = -1;
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "user") {
      turnIndex++;
      blocks.push(block(index, index, [message], turnIndex, false, estimator));
      index++;
      continue;
    }
    if (message.role === "assistant") {
      const toolUses = message.content.filter((content): content is ToolUseContent => content.type === "tool_use");
      if (toolUses.length === 0) {
        blocks.push(block(index, index, [message], Math.max(turnIndex, 0), false, estimator));
        index++;
        continue;
      }
      const ids = new Set(toolUses.map((toolUse) => toolUse.id));
      const blockMessages: NonSystemMessage[] = [message];
      let end = index;
      let seen = 0;
      let scan = index + 1;
      while (scan < messages.length && seen < ids.size) {
        const candidate = messages[scan]!;
        if (candidate.role !== "tool") break;
        const matched = candidate.content.some((content) => ids.has(content.tool_use_id));
        if (!matched) break;
        blockMessages.push(candidate);
        seen += candidate.content.filter((content) => ids.has(content.tool_use_id)).length;
        end = scan;
        scan++;
      }
      blocks.push(block(index, end, blockMessages, Math.max(turnIndex, 0), seen < ids.size, estimator));
      index = end + 1;
      continue;
    }
    blocks.push(block(index, index, [message], Math.max(turnIndex, 0), true, estimator));
    index++;
  }
  return blocks;
}

export function validateMessageBlocks(messages: readonly NonSystemMessage[]) {
  const invalid = buildMessageBlocks(messages).find((candidate) => candidate.incomplete);
  if (invalid) {
    throw new Error("Context contains an incomplete tool-use block.");
  }
}

export function reduceToolResultBlock(
  messages: readonly NonSystemMessage[],
  maxResultCharacters: number,
): NonSystemMessage[] | null {
  let changed = false;
  const reduced = messages.map((message): NonSystemMessage => {
    if (message.role !== "tool") return structuredClone(message);
    return {
      ...structuredClone(message),
      content: message.content.map((content) => {
        const next = reduceToolResultContent(content.content, maxResultCharacters);
        if (next === content.content) return structuredClone(content);
        changed = true;
        return { ...structuredClone(content), content: next };
      }),
    };
  });
  return changed ? reduced : null;
}

function block(
  start: number,
  end: number,
  messages: NonSystemMessage[],
  turnIndex: number,
  incomplete: boolean,
  estimator: TokenEstimator,
): ContextMessageBlock {
  return {
    start,
    end,
    messages,
    estimatedTokens: estimator.estimateMessages(messages),
    turnIndex,
    incomplete,
  };
}

function reduceToolResultContent(content: string, maxCharacters: number): string {
  const limit = Math.max(128, Math.floor(maxCharacters));
  if (content.length <= limit) return content;

  const structured = structuredToolResultSummary(content, limit);
  if (structured) return structured;
  return boundedHeadTail(content, limit);
}

function structuredToolResultSummary(content: string, limit: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const retained = ["summary", "error", "code"].filter((key) => typeof record[key] === "string");
  if (retained.length === 0) return null;

  let fieldLimit = Math.max(24, Math.floor((limit - 96) / retained.length));
  let serialized: string;
  do {
    const result: Record<string, unknown> = {
      contextReduced: true,
      originalCharacters: content.length,
    };
    for (const key of retained) {
      result[key] = boundedHeadTail(record[key] as string, fieldLimit);
    }
    serialized = JSON.stringify(result);
    fieldLimit = Math.max(1, Math.floor(fieldLimit * 0.75));
  } while (serialized.length > limit && fieldLimit > 1);

  return serialized;
}

function boundedHeadTail(content: string, limit: number): string {
  if (content.length <= limit) return content;
  let omitted = content.length - limit;
  let marker = "";
  let retained = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    marker = `\n[... ${omitted} characters omitted from this model context ...]\n`;
    retained = Math.max(0, limit - marker.length);
    omitted = content.length - retained;
  }
  if (marker.length >= limit) return content.slice(0, limit);
  const head = Math.ceil(retained / 2);
  return `${content.slice(0, head)}${marker}${content.slice(content.length - (retained - head))}`;
}
