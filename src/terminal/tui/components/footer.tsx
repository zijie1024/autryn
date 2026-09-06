import { Box, Text } from "ink";

import { useAgentLoop } from "../hooks/use-agent-loop";
import { currentTheme } from "../themes";

function formatTokenCount(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

export function Footer() {
  const { agent, session, tokenUsage } = useAgentLoop();
  const label = session
    ? `${session.displayName} · ${session.activeAgentGroupId} · ${session.activeAgentId}${session.activeAgentMissing ? " (missing)" : ""} · ${session.activeModelName ?? "(model missing)"} · ${session.activeExecutionMode === "dry_run" ? "DRY-RUN" : "EXECUTE"}`
    : (agent?.model.name ?? "(no model)");
  return (
    <Box paddingX={2} width="100%">
      <Box flexGrow={1} justifyContent="flex-start">
        <Text color={currentTheme.colors.dimText}>{label}</Text>
      </Box>
      <Box justifyContent="flex-end">
        <Text color={currentTheme.colors.dimText}>
          last input {formatTokenCount(tokenUsage.latestInputTokens)} · total {formatTokenCount(tokenUsage.totalTokens)}
        </Text>
      </Box>
    </Box>
  );
}
