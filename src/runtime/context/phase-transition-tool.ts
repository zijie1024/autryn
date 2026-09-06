import { z } from "zod";

import { defineTool } from "@/core";

import type { RuntimeContextManager } from "./context-manager";

const phaseTransitionSchema = z.object({
  objective: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500).optional(),
});

export function createPhaseTransitionTool(contextManager: RuntimeContextManager) {
  return defineTool({
    name: "phase_transition",
    description:
      "Register a transition to a new work phase after the current turn completes. Use it when the conversation moves to a distinct objective.",
    parameters: phaseTransitionSchema,
    effect: {
      kind: "ephemeral",
      scope: "process",
      description: "Records an in-memory phase transition request for the current context manager.",
    },
    execute: async (input) => contextManager.requestPhaseTransition(input),
  });
}
