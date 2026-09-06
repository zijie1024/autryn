import { Box, Text, useInput } from "ink";
import React, { useCallback, useMemo, useRef, useState } from "react";

import type { AskUserQuestionItem, AskUserQuestionResult } from "@/coding";

import { currentTheme } from "../themes";

import { Markdown } from "./markdown";

function buildInitialSelections(questions: AskUserQuestionItem[]): string[][] {
  return questions.map((q) => (q.multi_select ? [] : [q.options[0]!.label]));
}

function buildInitialFocus(questions: AskUserQuestionItem[]): number[] {
  return questions.map(() => 0);
}

function canSubmit(questions: AskUserQuestionItem[], selections: string[][]): boolean {
  return questions.every((q, i) => {
    const s = selections[i]!;
    if (q.multi_select) return s.length >= 1;
    return s.length === 1;
  });
}

function tabLabel(header: string): string {
  return header.length > 12 ? `${header.slice(0, 11)}…` : header;
}

export interface AskUserQuestionPromptProps {
  questions: AskUserQuestionItem[];
  /** 用户确认时 resolve；参数是给 model 的结构化回答。 */
  onSubmit: (answer: AskUserQuestionResult) => void;
}

export function AskUserQuestionPrompt({ questions, onSubmit }: AskUserQuestionPromptProps) {
  const qCount = questions.length;
  const reviewTabIndex = qCount >= 2 ? qCount : -1;

  const [tabIndex, setTabIndex] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() => buildInitialSelections(questions));
  const [focusIdx, setFocusIdx] = useState<number[]>(() => buildInitialFocus(questions));

  const stateRef = useRef({ tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex });
  stateRef.current = { tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex };

  const trySubmit = useCallback(() => {
    const { selections: sel, questions: qs } = stateRef.current;
    if (!canSubmit(qs, sel)) return;
    onSubmit({
      answers: qs.map((_, i) => ({
        question_index: i,
        selected_labels: [...sel[i]!],
      })),
    });
  }, [onSubmit]);

  useInput((input, key) => {
    const s = stateRef.current;
    const { qCount: n, reviewTabIndex: review, questions: qs } = s;
    const { tabIndex: tab, focusIdx: focus } = s;

    const onQuestionTab = tab < n;
    const isReview = review >= 0 && tab === review;

    if (key.leftArrow && n >= 2) {
      setTabIndex((t) => (t === 0 ? review! : t - 1));
      return;
    }
    if (key.rightArrow && n >= 2) {
      setTabIndex((t) => (t === review! ? 0 : t + 1));
      return;
    }

    if (key.upArrow && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      const cur = focus[qi]!;
      const ni = cur > 0 ? cur - 1 : q.options.length - 1;
      setFocusIdx((prev) => {
        const next = [...prev];
        next[qi] = ni;
        return next;
      });
      if (!q.multi_select) {
        const label = q.options[ni]!.label;
        setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
      }
      return;
    }

    if (key.downArrow && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      const cur = focus[qi]!;
      const ni = cur < q.options.length - 1 ? cur + 1 : 0;
      setFocusIdx((prev) => {
        const next = [...prev];
        next[qi] = ni;
        return next;
      });
      if (!q.multi_select) {
        const label = q.options[ni]!.label;
        setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
      }
      return;
    }

    if (key.return) {
      if (n === 1) {
        trySubmit();
        return;
      }
      if (isReview) {
        trySubmit();
        return;
      }
      if (tab < n - 1) {
        setTabIndex(tab + 1);
      } else {
        setTabIndex(review!);
      }
      return;
    }

    if (input === " " && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      if (!q.multi_select) return;
      const fi = focus[qi]!;
      const label = q.options[fi]!.label;
      setSelections((se) => {
        const copy = se.map((row) => [...row]);
        const row = copy[qi]!;
        const j = row.indexOf(label);
        if (j >= 0) {
          row.splice(j, 1);
        } else {
          row.push(label);
        }
        return copy;
      });
    }
  });

  const tabRow = useMemo(() => {
    if (qCount < 2) return null;
    return (
      <Box flexDirection="row" columnGap={2} marginBottom={1} flexWrap="wrap">
        {questions.map((q, i) => (
          <Text key={i} color={tabIndex === i ? "cyan" : currentTheme.colors.dimText} bold={tabIndex === i}>
            {tabIndex === i ? "▸ " : "  "}
            {tabLabel(q.header)}
          </Text>
        ))}
        <Text
          key="review"
          color={tabIndex === reviewTabIndex ? "cyan" : currentTheme.colors.dimText}
          bold={tabIndex === reviewTabIndex}
        >
          {tabIndex === reviewTabIndex ? "▸ " : "  "}
          Confirm
        </Text>
      </Box>
    );
  }, [qCount, questions, tabIndex, reviewTabIndex]);

  const hint =
    qCount >= 2
      ? "←/→ tab · ↑/↓ option · Space multi-toggle · Enter next or confirm"
      : "↑/↓ option · Space multi-toggle · Enter confirm";

  const showReview = qCount >= 2 && tabIndex === reviewTabIndex;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {tabRow}
      <Box marginTop={1} flexDirection="column">
        {showReview ? (
          <ReviewPanel questions={questions} selections={selections} />
        ) : (
          <QuestionPanel
            question={questions[tabIndex]!}
            focusIdx={focusIdx[tabIndex]!}
            selections={selections[tabIndex]!}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

function ReviewPanel({ questions, selections }: { questions: AskUserQuestionItem[]; selections: string[][] }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Review choices</Text>
      {questions.map((q, i) => (
        <Box key={i} flexDirection="column">
          <Text color={currentTheme.colors.highlightedText}>{q.header}</Text>
          <Text dimColor>{selections[i]!.length ? selections[i]!.join(", ") : "(none selected)"}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Press Enter to submit.</Text>
      </Box>
    </Box>
  );
}

function QuestionPanel({
  question,
  focusIdx,
  selections,
}: {
  question: AskUserQuestionItem;
  focusIdx: number;
  selections: string[];
}) {
  const focusedOption = question.options[focusIdx];
  const showPreview = !question.multi_select && focusedOption?.preview;

  return (
    <Box flexDirection="column" rowGap={0}>
      <Text bold>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((opt, i) => {
          const focused = i === focusIdx;
          const selected = question.multi_select ? selections.includes(opt.label) : focused;
          const prefix = question.multi_select ? (selected ? "[×] " : "[ ] ") : focused ? "❯ " : "  ";
          return (
            <Box key={i} flexDirection="column">
              <Text color={focused ? "cyan" : undefined}>
                {prefix}
                {opt.label}
              </Text>
              {focused && (
                <Text dimColor>
                  {"   "}
                  {opt.description}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      {showPreview && focusedOption?.preview && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor={currentTheme.colors.borderColor}
          paddingX={1}
        >
          <Markdown>{focusedOption.preview}</Markdown>
        </Box>
      )}
    </Box>
  );
}
