import { useInput } from "ink";
import { useEffect, useMemo, useState } from "react";

import {
  buildPromptSubmission,
  filterCommands,
  getHighlightedCommandName,
  getSlashQuery,
  insertSlashCommand,
  type PromptSubmission,
  type SlashCommand,
} from "../command-registry";
import {
  type InputEditorState,
  insertTextAtCursor,
  moveCursorLeft,
  moveCursorRight,
  moveCursorWordLeft,
  moveCursorWordRight,
  removeCharacterBeforeCursor,
} from "../input-editor";

import { useInputHistory } from "./use-input-history";

export const FIRST_INPUT_PLACEHOLDER =
  "New session in this process. Type a message; up/down recalls saved input history, not past conversations.";

export function useCommandInput({
  commands,
  onSubmit,
  onAbort,
}: {
  commands: SlashCommand[];
  onSubmit?: (submission: PromptSubmission) => void;
  onAbort?: () => void;
}) {
  const [firstMessage, setFirstMessage] = useState(true);
  const [editorState, setEditorState] = useState<InputEditorState>({ text: "", cursorOffset: 0 });
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { isBrowsing, browseUp, browseDown, exitBrowsing, saveEntry } = useInputHistory();

  const slashQuery = getSlashQuery(editorState.text);
  const filteredCommands = useMemo(
    () => (slashQuery === null ? [] : filterCommands(commands, slashQuery)),
    [commands, slashQuery],
  );
  const pickerOpen = slashQuery !== null && dismissedQuery !== slashQuery;
  const highlightedCommandName = getHighlightedCommandName(editorState.text, commands);

  useEffect(() => {
    setSelectedIndex((currentIndex) => {
      if (filteredCommands.length === 0) return 0;
      return Math.min(currentIndex, filteredCommands.length - 1);
    });
  }, [filteredCommands.length]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [slashQuery]);

  const updateEditorState = (nextState: InputEditorState) => {
    setEditorState(nextState);
    if (getSlashQuery(nextState.text) !== dismissedQuery) {
      setDismissedQuery(null);
    }
  };

  const acceptSelectedCommand = () => {
    const selectedCommand = filteredCommands[selectedIndex];
    if (!selectedCommand) return;

    updateEditorState({
      text: insertSlashCommand(selectedCommand),
      cursorOffset: insertSlashCommand(selectedCommand).length,
    });
    setSelectedIndex(0);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onAbort?.();
        return;
      }

      if (pickerOpen && key.escape) {
        setDismissedQuery(slashQuery);
        return;
      }

      if (key.escape) {
        onAbort?.();
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && key.upArrow) {
        setSelectedIndex((index) => (index > 0 ? index - 1 : filteredCommands.length - 1));
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && key.downArrow) {
        setSelectedIndex((index) => (index < filteredCommands.length - 1 ? index + 1 : 0));
        return;
      }

      if (pickerOpen && filteredCommands.length > 0 && (key.return || key.tab)) {
        acceptSelectedCommand();
        return;
      }

      if (key.return) {
        saveEntry(editorState.text);
        onSubmit?.(buildPromptSubmission(editorState.text, commands));
        setEditorState({ text: "", cursorOffset: 0 });
        setDismissedQuery(null);
        setSelectedIndex(0);
        setFirstMessage(false);
        return;
      }

      if (key.leftArrow || (key.meta && input === "b")) {
        updateEditorState(key.meta ? moveCursorWordLeft(editorState) : moveCursorLeft(editorState));
        return;
      }

      if (key.rightArrow || (key.meta && input === "f")) {
        updateEditorState(key.meta ? moveCursorWordRight(editorState) : moveCursorRight(editorState));
        return;
      }

      if (key.backspace || key.delete) {
        exitBrowsing();
        updateEditorState(removeCharacterBeforeCursor(editorState));
        return;
      }

      if (!pickerOpen && (editorState.text === "" || isBrowsing) && key.upArrow) {
        const entry = browseUp();
        if (entry !== null) {
          setEditorState({ text: entry, cursorOffset: entry.length });
        }
        return;
      }

      if (!pickerOpen && isBrowsing && key.downArrow) {
        const entry = browseDown();
        if (entry !== null) {
          setEditorState({ text: entry, cursorOffset: entry.length });
        }
        return;
      }

      if (key.upArrow || key.downArrow || key.tab) {
        return;
      }

      exitBrowsing();
      updateEditorState(insertTextAtCursor(editorState, input));
    },
    { isActive: true },
  );

  return {
    filteredCommands,
    highlightedCommandName,
    pickerOpen,
    placeholder: firstMessage
      ? FIRST_INPUT_PLACEHOLDER
      : "Input anything to continue. Launch a new command or skill by typing `/`",
    selectedIndex,
    text: editorState.text,
    cursorOffset: editorState.cursorOffset,
  };
}
