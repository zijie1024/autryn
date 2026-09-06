import { Box, Text } from "ink";
import { useMemo } from "react";

import { useAnimationFrame } from "../hooks/use-animation-frame";
import { currentTheme } from "../themes";

const LOADING_MESSAGES = [
  "Working on it...",
  "Acting...",
  "Thinking...",
  "Processing...",
  "Working hard...",
  "Waaaaaait...",
  "Almost there...",
];

const DEFAULT_CHARACTERS =
  process.platform === "darwin" ? ["·", "✢", "✳", "✶", "✻", "✽"] : ["·", "✢", "*", "✶", "✻", "✽"];

const SPINNER_FRAMES = [...DEFAULT_CHARACTERS, ...[...DEFAULT_CHARACTERS].reverse()];

const SHIMMER_WIDTH = 3;

export function StreamingIndicator({ streaming, nextTodo }: { streaming: boolean; nextTodo?: string }) {
  const loadingMessage = useMemo(() => LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)]!, []);

  const time = useAnimationFrame(streaming ? 120 : null);

  if (!streaming) return null;

  const spinnerFrame = Math.floor(time / 120) % SPINNER_FRAMES.length;
  const spinnerChar = SPINNER_FRAMES[spinnerFrame]!;

  const messageLength = loadingMessage.length;
  const cycleLength = messageLength + SHIMMER_WIDTH * 2;
  const glimmerPos = Math.floor(time / 100) % cycleLength;

  const shimmerStart = glimmerPos - SHIMMER_WIDTH;
  const shimmerEnd = glimmerPos + SHIMMER_WIDTH;

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text color={currentTheme.colors.primary}>{spinnerChar}</Text>
        <ShimmerText
          text={loadingMessage}
          shimmerStart={shimmerStart}
          shimmerEnd={shimmerEnd}
          baseColor={currentTheme.colors.primary}
          shimmerColor={currentTheme.colors.highlightedText}
        />
      </Box>
      {nextTodo && <Text color={currentTheme.colors.dimText}>Next: {nextTodo}</Text>}
    </Box>
  );
}

function ShimmerText({
  text,
  shimmerStart,
  shimmerEnd,
  baseColor,
  shimmerColor,
}: {
  text: string;
  shimmerStart: number;
  shimmerEnd: number;
  baseColor: string;
  shimmerColor: string;
}) {
  if (shimmerStart >= text.length || shimmerEnd < 0) {
    return <Text color={baseColor}>{text}</Text>;
  }

  const clampedStart = Math.max(0, shimmerStart);
  const clampedEnd = Math.min(text.length, shimmerEnd);

  const before = text.slice(0, clampedStart);
  const shimmer = text.slice(clampedStart, clampedEnd);
  const after = text.slice(clampedEnd);

  return (
    <Text>
      {before && <Text color={baseColor}>{before}</Text>}
      <Text color={shimmerColor} bold>
        {shimmer}
      </Text>
      {after && <Text color={baseColor}>{after}</Text>}
    </Text>
  );
}
