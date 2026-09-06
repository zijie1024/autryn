import type { AssistantMessage, NonSystemMessage, ToolUseContent, UserMessage } from "@/core";

import { toolUseSummary } from "./tool-summary";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const WHITE = `${ESC}37m`;
const GRAY = `${ESC}90m`;

const white = (s: string) => `${WHITE}${s}${RESET}`;
const bold = (s: string) => `${BOLD}${s}${RESET}`;
const dim = (s: string) => `${DIM}${GRAY}${s}${RESET}`;

export function messageToPlainText(message: NonSystemMessage): string | null {
  switch (message.role) {
    case "user":
      return userMessageText(message);
    case "assistant":
      return assistantMessageText(message);
    case "tool":
      return null;
    default:
      return null;
  }
}

function userMessageText(message: UserMessage): string {
  const text = message.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
  return `${bold(white("❯"))} ${white(text)}`;
}

function assistantMessageText(message: AssistantMessage): string {
  const parts: string[] = [];
  for (const content of message.content) {
    switch (content.type) {
      case "text":
        if (content.text) {
          parts.push(`${white("•")} ${content.text}`);
        }
        break;
      case "tool_use":
        parts.push(toolUseText(content));
        break;
    }
  }
  return parts.join("\n");
}

function toolUseText(content: ToolUseContent): string {
  // todo_write 的丰富状态只在 TUI 中渲染；这里保持一行稳定的最小输出。
  if (content.name === "todo_write") {
    return `${dim("•")} Working on todos`;
  }
  const summary = toolUseSummary(content);
  if (!summary) {
    return `${dim("•")} Tool call\n  ${dim(`└─ ${content.name}`)}`;
  }
  const detail = summary.detail ? `\n  ${dim(`└─ ${summary.detail}`)}` : "";
  return `${dim("•")} ${summary.title}${detail}`;
}
