import { describe, expect, test } from "bun:test";

import type { ExecutionResult } from "@/runtime";
import { MemorySessionStore, SessionService } from "@/sessions";
import { SessionCommitCoordinator } from "@/terminal/session/session-commit-coordinator";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TURN_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_GROUP = { id: "default-coding", revision: "a".repeat(64) };

describe("SessionCommitCoordinator", () => {
  test("commits a parallel Tool Result batch as one revision", async () => {
    const store = new MemorySessionStore();
    let messageIndex = 0;
    const service = new SessionService({
      store,
      ids: {
        sessionId: () => SESSION_ID,
        turnId: () => TURN_ID,
        messageId: () => `44444444-4444-4444-8444-${String(++messageIndex).padStart(12, "0")}`,
      },
    });
    const started = await service.startTurn(
      service.createDraft({
        cwd: process.cwd(),
        activeAgentId: "code",
        activeAgentGroupId: AGENT_GROUP.id,
      }),
      AGENT_GROUP,
      { role: "user", content: [{ type: "text", text: "run both" }] },
    );
    const coordinator = new SessionCommitCoordinator(service, started.record.id, started.turn.id, () => {});
    coordinator.addEffectiveModel({
      executionId: "root",
      agentId: "code",
      configId: MODEL_ID,
      configName: "test",
      provider: "openai",
      model: "test-model",
    });

    const toolCall = await coordinator.checkpoint({
      reason: "tool_call",
      executionId: "root",
      rootExecutionId: "root",
      branchId: "root",
      agentId: "code",
      step: 1,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool-1", name: "first", input: {} },
            { type: "tool_use", id: "tool-2", name: "second", input: {} },
          ],
        },
      ],
    });
    const toolResults = await coordinator.checkpoint({
      reason: "step_completed",
      executionId: "root",
      rootExecutionId: "root",
      branchId: "root",
      agentId: "code",
      step: 1,
      messages: [
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "first" }] },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: "tool-2", content: "second" }] },
      ],
    });
    const result: ExecutionResult = {
      executionId: "root",
      rootExecutionId: "root",
      branchId: "root",
      agentId: "code",
      status: "completed",
      mode: "execute",
      output: {
        text: "done",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      steps: 2,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, usageIncomplete: false },
      durationMs: 1,
    };
    const finished = await coordinator.finish(result, { finalMessage: result.output!.message });

    expect(started.record.revision).toBe(1);
    expect(toolCall.revision).toBe(2);
    expect(toolResults.revision).toBe(3);
    expect(finished.revision).toBe(4);
    expect(finished.messages.map((entry) => entry.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(finished.turns[0]?.effectiveModels).toHaveLength(1);
  });
});
