import { Box, Text } from "ink";

import { currentTheme } from "../themes";
import type { TodoItemView } from "../todo-view";

export function TodoPanel({ todos }: { todos?: TodoItemView[] }) {
  if (!todos || todos.length === 0) return null;

  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const pendingCount = todos.filter((todo) => todo.status === "pending").length;
  const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="single"
      borderColor={currentTheme.colors.borderColor}
      paddingX={1}
    >
      <Box columnGap={1}>
        <Text color={currentTheme.colors.primary}>Tasks</Text>
        <Text color={currentTheme.colors.dimText}>
          {completedCount} completed
          {inProgressCount > 0 ? `, ${inProgressCount} in progress` : ""}
          {pendingCount > 0 ? `, ${pendingCount} pending` : ""}
        </Text>
      </Box>
      {todos.map((todo) => (
        <Box key={todo.id} columnGap={1}>
          <Text color={getTodoColor(todo.status)}>{getTodoIcon(todo.status)}</Text>
          <Text color={todo.status === "completed" ? currentTheme.colors.dimText : undefined}>{todo.content}</Text>
        </Box>
      ))}
    </Box>
  );
}

function getTodoIcon(status: string) {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "cancelled":
      return "✕";
    case "pending":
    default:
      return "○";
  }
}

function getTodoColor(status: string) {
  switch (status) {
    case "completed":
      return "green";
    case "in_progress":
      return currentTheme.colors.primary;
    case "cancelled":
      return "red";
    default:
      return currentTheme.colors.dimText;
  }
}
