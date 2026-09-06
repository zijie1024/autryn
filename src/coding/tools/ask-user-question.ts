import z from "zod";

import { defineTool } from "@/core";

/**
 * {@link AskUserQuestionItem} 内的单个可选选项。
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/**
 * 呈现给用户的单个问题。
 */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  /** 2–4 个选项；除非 {@link multi_select} 为 true，否则互斥。 */
  options: AskUserQuestionOption[];
  multi_select: boolean;
}

/**
 * `ask_user_question` tool 的输入参数。
 */
export interface AskUserQuestionParameters {
  questions: AskUserQuestionItem[];
}

export interface AskUserQuestionAnswer {
  question_index: number;
  selected_labels: string[];
}

export interface AskUserQuestionResult {
  answers: AskUserQuestionAnswer[];
}

const askUserQuestionOptionSchema = z.object({
  label: z.string().describe("Short display label for this choice (1–5 words)."),
  description: z.string().describe("What this choice means or implies."),
  preview: z
    .string()
    .optional()
    .describe("Optional markdown preview when this option is focused (single-select only)."),
});

const askUserQuestionItemSchema = z.object({
  question: z.string().describe("Full question text; be specific and end with a question mark where appropriate."),
  header: z
    .string()
    .max(12)
    .describe("Very short tab/tag label (max 12 characters), e.g. Auth, Library."),
  options: z
    .array(askUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe("2–4 distinct choices; mutually exclusive unless multi_select is true."),
  multi_select: z
    .boolean()
    .describe("If true, the user may pick multiple options; if false, exactly one."),
});

export const askUserQuestionParametersSchema = z.object({
  questions: z
    .array(askUserQuestionItemSchema)
    .min(1)
    .max(4)
    .describe("1–4 parallel, independent questions (no dependency between them)."),
});

function validateResultAgainstParams(params: AskUserQuestionParameters, result: AskUserQuestionResult): void {
  if (result.answers.length !== params.questions.length) {
    throw new Error(`ask_user_question: expected ${params.questions.length} answers, got ${result.answers.length}`);
  }
  const byIndex = new Map(result.answers.map((a) => [a.question_index, a]));
  for (let i = 0; i < params.questions.length; i++) {
    const q = params.questions[i]!;
    const a = byIndex.get(i);
    if (!a) {
      throw new Error(`ask_user_question: missing answer for question_index ${i}`);
    }
    const labels = new Set(q.options.map((o) => o.label));
    for (const l of a.selected_labels) {
      if (!labels.has(l)) {
        throw new Error(`ask_user_question: unknown label "${l}" for question ${i}`);
      }
    }
    if (q.multi_select) {
      if (a.selected_labels.length < 1) {
        throw new Error(`ask_user_question: multi-select question ${i} requires at least one selection`);
      }
    } else if (a.selected_labels.length !== 1) {
      throw new Error(`ask_user_question: single-select question ${i} requires exactly one selection`);
    }
  }
}

/**
 * tool：向用户提出一个或多个并行的多选题（支持多选）。
 * 宿主必须提供 `callback`，阻塞直到用户提交（如 TUI 场景）。
 */
export function createAskUserQuestionTool(
  callback: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>,
) {
  return defineTool({
    name: "ask_user_question",
    description: `Ask the user one or more independent questions with fixed choices. Prefer this over free-form questions when options are clear. Questions are parallel (no dependency between them). You may send 1–4 questions in one call. For each question set multi_select true only when multiple answers make sense.`,
    parameters: askUserQuestionParametersSchema,
    effect: {
      kind: "interaction",
      scope: "process",
      description: "Asks the user for input without committing workspace changes.",
    },
    execute: async (input, context) => {
      const params = askUserQuestionParametersSchema.parse(input);
      if (context.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const result = await callback(params);
      if (context.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      validateResultAgainstParams(params, result);
      return JSON.stringify(result);
    },
  });
}
