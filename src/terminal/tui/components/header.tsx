import { Box, Text } from "ink";

import { AUTRYN_VERSION } from "../../version";
import { useAgentLoop } from "../hooks/use-agent-loop";
import { currentTheme } from "../themes";

/**
 * 纯文本的启动 header。刻意不包含吉祥物/ASCII 艺术：
 * 每行都是可读文本，颜色只用于淡化次要信息，纵向布局在窄终端下可自然换行。
 */
export function Header() {
  const { agent, session } = useAgentLoop();
  const modelName = session?.activeModelName ?? agent?.model.name ?? "(missing)";
  const directory = session?.cwd ?? process.cwd();
  const sessionText = session
    ? `${session.displayName} (${session.materialized ? session.shortId : "draft"})`
    : "New session";
  return (
    <Box flexDirection="column" rowGap={1}>
      <Box columnGap={1}>
        <Text bold>Autryn</Text>
        <Text color={currentTheme.colors.dimText}>v{AUTRYN_VERSION}</Text>
      </Box>
      <Box flexDirection="column">
        <Text color={currentTheme.colors.dimText}>Session: {sessionText}</Text>
        <Text color={currentTheme.colors.dimText}>Active model: {modelName}</Text>
        <Text color={currentTheme.colors.dimText}>Directory: {directory}</Text>
        <Text color={currentTheme.colors.dimText}>
          Plain `autryn` starts a new draft. Use `/resume` or `autryn --continue` to restore saved work.
        </Text>
      </Box>
    </Box>
  );
}
