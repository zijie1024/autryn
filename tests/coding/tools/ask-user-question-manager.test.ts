import { describe, expect, it } from "bun:test";

import type { AskUserQuestionParameters, AskUserQuestionResult } from "@/coding/tools/ask-user-question";
import { AskUserQuestionManager } from "@/coding/tools/ask-user-question-manager";

const sampleParams = (n = 1): AskUserQuestionParameters => ({
  questions: Array.from({ length: n }, (_, i) => ({
    question: `Q${i}?`,
    header: `H${i}`,
    multi_select: false,
    options: [
      { label: "A", description: "a" },
      { label: "B", description: "b" },
    ],
  })),
});

describe("AskUserQuestionManager", () => {
  it("resolves requests in FIFO order", async () => {
    const m = new AskUserQuestionManager();
    const out: string[] = [];
    const p1 = m.askUserQuestion(sampleParams(1)).then((r) => {
      out.push("1");
      return r;
    });
    const p2 = m.askUserQuestion(sampleParams(1)).then((r) => {
      out.push("2");
      return r;
    });

    const r1: AskUserQuestionResult = { answers: [{ question_index: 0, selected_labels: ["A"] }] };
    m.respondWithAnswers(r1);
    await p1;
    expect(out).toEqual(["1"]);

    m.respondWithAnswers(r1);
    await p2;
    expect(out).toEqual(["1", "2"]);
  });

  it("notifies subscriber with current request", () => {
    const m = new AskUserQuestionManager();
    let seen: unknown = "unset";
    m.subscribe((req) => {
      seen = req?.params.questions.length ?? null;
    });
    void m.askUserQuestion(sampleParams(2));
    expect(seen).toBe(2);
  });
});
