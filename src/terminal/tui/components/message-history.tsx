import { Box, Text } from "ink";
import { memo } from "react";

import type { AssistantMessage, NonSystemMessage, ToolUseContent, UserMessage } from "@/core";

import { currentTheme } from "../themes";
import { getCurrentTodo, getNextTodo, snapshotKey, type TodoItemView } from "../todo-view";
import { toolUseSummary } from "../tool-summary";

import { Markdown } from "./markdown";

export const MessageHistory = memo(function MessageHistory({
  messages,
  startIndex = 0,
  todoSnapshots,
}: {
  messages: NonSystemMessage[];
  startIndex?: number;
  todoSnapshots: Map<string, TodoItemView[]>;
}) {
  return (
    <Box flexDirection="column" width="100%">
      {messages.map((message, index) => {
        return (
          <MessageHistoryItem
            key={getMessageKey(message, index)}
            message={message}
            messageIndex={startIndex + index}
            todoSnapshots={todoSnapshots}
          />
        );
      })}
    </Box>
  );
});

export const MessageHistoryItem = memo(function MessageHistoryItem({
  message,
  messageIndex,
  todoSnapshots,
}: {
  message: NonSystemMessage;
  messageIndex: number;
  todoSnapshots: Map<string, TodoItemView[]>;
}) {
  switch (message.role) {
    case "user":
      return (
        <Box flexDirection="column" width="100%">
          {messageIndex > 0 && <Text> </Text>}
          <UserMessageItem message={message} />
        </Box>
      );
    case "assistant":
      return <AssistantMessageItem message={message} todoSnapshots={todoSnapshots} messageIndex={messageIndex} />;
    case "tool":
      return null;
    default:
      return null;
  }
});

const UserMessageItem = memo(function UserMessageItem({ message }: { message: UserMessage }) {
  return (
    <Box columnGap={1} width="100%" backgroundColor={currentTheme.colors.secondaryBackground}>
      <Text color="white" bold>
        ❯
      </Text>
      <Text color="white">
        {message.content.map((content) => (content.type === "text" ? content.text : "[image]")).join("\n")}
      </Text>
    </Box>
  );
});

const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  todoSnapshots,
  messageIndex,
}: {
  message: AssistantMessage;
  todoSnapshots: Map<string, TodoItemView[]>;
  messageIndex: number;
}) {
  return (
    <Box flexDirection="column" width="100%">
      {message.content.map((content, i) => {
        switch (content.type) {
          case "text":
            if (content.text) {
              return (
                <Box key={i} columnGap={1}>
                  <Text color={currentTheme.colors.highlightedText}>•</Text>
                  <Box flexDirection="column" rowGap={0}>
                    <Markdown>{content.text}</Markdown>
                  </Box>
                </Box>
              );
            }
            return null;
          case "tool_use":
            return (
              <Box key={i} columnGap={1}>
                <Text color={currentTheme.colors.dimText}>•</Text>
                <Box flexDirection="column">
                  <ToolUseContentItem content={content} todos={todoSnapshots.get(snapshotKey(messageIndex, i))} />
                </Box>
              </Box>
            );
          default:
            return null;
        }
      })}
    </Box>
  );
});

const ToolUseContentItem = memo(function ToolUseContentItem({
  content,
  todos,
}: {
  content: ToolUseContent;
  todos?: TodoItemView[];
}) {
  // todo_write 是唯一一个摘要依赖重建后 todo 快照的 tool，
  // 因此在这里（以及 ANSI 渲染器中）保持特殊处理。
  if (content.name === "todo_write") {
    const visibleTodos = todos;
    const currentTodo = getCurrentTodo(visibleTodos);
    const nextTodo = getNextTodo(visibleTodos);
    const summaryTodo = currentTodo ?? nextTodo;
    const completedCount = visibleTodos?.filter((todo) => todo.status === "completed").length ?? 0;
    const pendingCount = visibleTodos?.filter((todo) => todo.status === "pending").length ?? 0;

    return (
      <Box flexDirection="column">
        <Text>{summaryTodo ? `Working on: ${summaryTodo.content}` : "Todo list complete"}</Text>
        {(completedCount > 0 || pendingCount > 0) && (
          <Text color={currentTheme.colors.dimText}>
            └─ {completedCount} completed{pendingCount > 0 ? `, ${pendingCount} pending` : ""}
          </Text>
        )}
      </Box>
    );
  }

  const summary = toolUseSummary(content);
  if (!summary) {
    return (
      <Box flexDirection="column">
        <Text>Tool call</Text>
        <Text color={currentTheme.colors.dimText}>└─ {content.name}</Text>
      </Box>
    );
  }

  // ask_user_question 把次要信息内联展示（标题在前），与既有 TUI 呈现一致；
  // 其他 tool 则显示为暗色的第二行。
  if (content.name === "ask_user_question") {
    return (
      <Box flexDirection="column">
        <Text>
          {summary.title}
          {summary.detail ? ` — ${summary.detail}` : ""}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{summary.title}</Text>
      {summary.detail ? <Text color={currentTheme.colors.dimText}>└─ {summary.detail}</Text> : null}
    </Box>
  );
});

function getMessageKey(message: NonSystemMessage, index: number) {
  switch (message.role) {
    case "user":
      return `user:${index}:${message.content.map((content) => (content.type === "text" ? content.text : "image")).join("|")}`;
    case "assistant":
      return `assistant:${index}:${message.content
        .map((content) => (content.type === "tool_use" ? content.id : content.type))
        .join("|")}`;
    case "tool":
      return `tool:${index}:${message.content.map((content) => content.tool_use_id).join("|")}`;
    default:
      return `${index}`;
  }
}
