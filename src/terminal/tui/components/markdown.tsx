import { Text } from "ink";
import { marked } from "marked";
import TerminalRenderer from "marked-terminal";
import { memo, useMemo } from "react";

marked.setOptions({
  renderer: new TerminalRenderer() as never,
});

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const rendered = useMemo(() => marked(children).trimEnd(), [children]);
  return <Text>{rendered}</Text>;
});
