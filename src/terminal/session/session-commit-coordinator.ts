import type { NonSystemMessage } from "@/core";
import type { ExecutionCheckpoint } from "@/runtime/execution/types";
import type { ExecutionBranchResult, ExecutionResult } from "@/runtime/execution/types";
import type { SessionService } from "@/sessions/session-service";
import type { PersistedSessionMessage, PersistedTurn, SessionRecord } from "@/sessions/session-types";

type EffectiveModel = PersistedTurn["effectiveModels"][number];

export class SessionCommitCoordinator {
  private readonly effectiveModels = new Map<string, EffectiveModel>();
  private pendingMessages: PersistedSessionMessage[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly service: SessionService,
    private readonly sessionId: string,
    private readonly turnId: string,
    private readonly onRecord: (record: SessionRecord) => void,
  ) {}

  addEffectiveModel(model: EffectiveModel): void {
    this.effectiveModels.set(model.executionId, model);
  }

  checkpoint(checkpoint: ExecutionCheckpoint): Promise<SessionRecord> {
    const messages = this.service.prepareMessages(this.turnId, checkpoint.messages);
    this.pendingMessages.push(...messages);
    return this.enqueue(async () => {
      const effectiveModels = this.snapshotEffectiveModels();
      const record = checkpoint.reason === "handoff_committed" && checkpoint.handoff
        ? await this.service.commitHandoff(this.sessionId, this.turnId, {
            messages,
            effectiveModels,
            handoff: checkpoint.handoff,
          })
        : await this.service.checkpointTurn(this.sessionId, this.turnId, {
            messages,
            effectiveModels,
          });
      this.removeEffectiveModels(effectiveModels);
      this.removePendingMessages(messages);
      this.onRecord(record);
      return record;
    });
  }

  finish(
    result: ExecutionResult | ExecutionBranchResult,
    options: {
      finalMessage?: NonSystemMessage;
      phaseTransition?: { nextObjective: string; policyVersion: string };
    } = {},
  ): Promise<SessionRecord> {
    const messages = options.finalMessage ? this.service.prepareMessages(this.turnId, [options.finalMessage]) : [];
    this.pendingMessages.push(...messages);
    return this.enqueue(async () => {
      const allMessages = [...this.pendingMessages];
      const record = await this.service.finishTurn(
        this.sessionId,
        this.turnId,
        result,
        this.snapshotEffectiveModels(),
        { messages: allMessages, phaseTransition: options.phaseTransition },
      );
      this.effectiveModels.clear();
      this.pendingMessages = [];
      this.onRecord(record);
      return record;
    });
  }

  private snapshotEffectiveModels(): EffectiveModel[] {
    return [...this.effectiveModels.values()];
  }

  private removeEffectiveModels(models: EffectiveModel[]): void {
    for (const model of models) {
      if (this.effectiveModels.get(model.executionId) === model) {
        this.effectiveModels.delete(model.executionId);
      }
    }
  }

  private removePendingMessages(messages: PersistedSessionMessage[]): void {
    const ids = new Set(messages.map((message) => message.id));
    this.pendingMessages = this.pendingMessages.filter((message) => !ids.has(message.id));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation, operation);
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}
