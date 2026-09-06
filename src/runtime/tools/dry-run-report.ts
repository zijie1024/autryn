import type { DryRunEntry, DryRunReport, TerminalExecutionStatus } from "@/runtime/execution/types";

export class DryRunReportBuilder {
  private readonly entries: DryRunEntry[] = [];
  private finishedAt?: string;
  private status: DryRunReport["status"] = "completed";

  constructor(
    private readonly runId: string,
    private readonly rootExecutionId: string,
    private readonly startedAt = new Date().toISOString(),
  ) {}

  add(entry: DryRunEntry) {
    this.entries.push(entry);
  }

  finish(status: TerminalExecutionStatus) {
    this.status = status === "completed" && this.entries.some((entry) => entry.disposition === "blocked") ? "partial" : status;
    this.finishedAt = new Date().toISOString();
  }

  snapshot(): DryRunReport {
    const summary = {
      executedReads: 0,
      executedEphemeral: 0,
      interactions: 0,
      controlOperations: 0,
      previews: 0,
      noChanges: 0,
      blocked: 0,
      indeterminate: 0,
    };

    for (const entry of this.entries) {
      if (entry.disposition === "blocked") summary.blocked++;
      if (entry.disposition === "previewed") summary.previews++;
      if (entry.preview?.status === "no_change") summary.noChanges++;
      if (entry.preview?.status === "indeterminate") summary.indeterminate++;
      if (entry.disposition === "executed" && entry.effect.kind === "read") summary.executedReads++;
      if (entry.disposition === "executed" && entry.effect.kind === "ephemeral") summary.executedEphemeral++;
      if (entry.disposition === "executed" && entry.effect.kind === "interaction") summary.interactions++;
      if (entry.disposition === "executed" && entry.effect.kind === "control") summary.controlOperations++;
    }

    return {
      runId: this.runId,
      rootExecutionId: this.rootExecutionId,
      mode: "dry_run",
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(),
      entries: this.entries.map((entry) => structuredClone(entry)),
      summary,
    };
  }
}
