import type { NonSystemMessage, ToolUseContent } from "@/core";

export type TodoItemView = {
  id: string;
  content: string;
  status: string;
};

export type TodoViewState = {
  latestTodos?: TodoItemView[];
  toolUses: Map<string, ToolUseContent>;
  todoSnapshots: Map<string, TodoItemView[]>;
};

export function snapshotKey(messageIndex: number, contentIndex: number) {
  return `${messageIndex}:${contentIndex}`;
}

/**
 * 找到最后一条 user 消息的下标，这样只查看当前对话轮次的 todos。
 */
function lastUserMessageIndex(messages: NonSystemMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return 0;
}

export function getLatestTodoSnapshotKey(messages: NonSystemMessage[]) {
  const turnStart = lastUserMessageIndex(messages);

  for (let messageIndex = messages.length - 1; messageIndex >= turnStart; messageIndex--) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") continue;

    for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
      const content = message.content[contentIndex];
      if (content && content.type === "tool_use" && content.name === "todo_write") {
        return snapshotKey(messageIndex, contentIndex);
      }
    }
  }

  return null;
}

export function buildTodoSnapshots(messages: NonSystemMessage[]): Map<string, TodoItemView[]> {
  return buildTodoViewState(messages).todoSnapshots;
}

export function buildTodoViewState(messages: NonSystemMessage[]): TodoViewState {
  const snapshots = new Map<string, TodoItemView[]>();
  const toolUses = new Map<string, ToolUseContent>();
  let store: TodoItemView[] = [];
  let latestTodos: TodoItemView[] | undefined;

  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === "user") {
      latestTodos = undefined;
      continue;
    }

    if (message.role !== "assistant") continue;

    for (const [contentIndex, content] of message.content.entries()) {
      if (content.type !== "tool_use") continue;

      toolUses.set(content.id, content);

      if (content.name !== "todo_write") continue;

      const input = toTodoWriteInput(content.input);
      store = applyTodoWrite(store, input);
      snapshots.set(snapshotKey(messageIndex, contentIndex), store);
      latestTodos = store;
    }
  }

  return {
    latestTodos,
    toolUses,
    todoSnapshots: snapshots,
  };
}

export function buildToolUseNames(messages: NonSystemMessage[]): Map<string, string> {
  const toolUseNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const content of message.content) {
      if (content.type !== "tool_use") continue;
      toolUseNames.set(content.id, content.name);
    }
  }

  return toolUseNames;
}

export function buildToolUses(messages: NonSystemMessage[]): Map<string, ToolUseContent> {
  return buildTodoViewState(messages).toolUses;
}

export function getCurrentTodo(todos?: TodoItemView[]) {
  return todos?.find((todo) => todo.status === "in_progress");
}

export function getNextTodo(todos?: TodoItemView[]) {
  return todos?.find((todo) => todo.status === "pending");
}

export function getLatestTodos(messages: NonSystemMessage[]) {
  return buildTodoViewState(messages).latestTodos;
}

function toTodoWriteInput(input: Record<string, unknown>): {
  merge: boolean;
  todos: TodoItemView[];
} {
  const merge = input.merge === true;
  const todos = Array.isArray(input.todos)
    ? input.todos.flatMap((item) => {
        if (!item || typeof item !== "object") return [];

        const candidate = item as Record<string, unknown>;
        if (typeof candidate.id !== "string") return [];
        if (typeof candidate.content !== "string") return [];
        if (typeof candidate.status !== "string") return [];

        return [
          {
            id: candidate.id,
            content: candidate.content,
            status: candidate.status,
          },
        ];
      })
    : [];

  return { merge, todos };
}

function applyTodoWrite(store: TodoItemView[], input: { merge: boolean; todos: TodoItemView[] }) {
  if (!input.merge) {
    return [...input.todos];
  }

  const next = [...store];
  for (const item of input.todos) {
    const index = next.findIndex((todo) => todo.id === item.id);
    if (index >= 0) {
      next[index] = item;
    } else {
      next.push(item);
    }
  }

  return next;
}
