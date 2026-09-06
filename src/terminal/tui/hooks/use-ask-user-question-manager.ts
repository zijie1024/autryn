import { useEffect, useState } from "react";

import { type AskUserQuestionRequest, type AskUserQuestionResult, globalAskUserQuestionManager } from "@/coding";

export function useAskUserQuestionManager() {
  const [request, setRequest] = useState<AskUserQuestionRequest | null>(null);

  useEffect(() => {
    return globalAskUserQuestionManager.subscribe((req) => {
      setRequest(req);
    });
  }, []);

  const respondWithAnswers = (result: AskUserQuestionResult) => {
    if (request) {
      globalAskUserQuestionManager.respondWithAnswers(result);
    }
  };

  return {
    askUserQuestionRequest: request,
    respondWithAnswers,
  };
}
