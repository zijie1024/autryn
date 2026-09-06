import type { ExecutionEvent, ExecutionSnapshot } from "@/runtime/execution/types";

import type { AgentExecution } from "./agent-execution";
import type { ExecutionBranch } from "./execution-branch";

export class AgentRun {
  readonly branchId: string;
  readonly result;
  readonly events: AsyncIterable<ExecutionEvent>;

  constructor(
    private readonly branch: ExecutionBranch,
    initialExecution: AgentExecution,
  ) {
    this.branchId = branch.id;
    this.result = branch.result;
    this.events = branch.events;
    branch.attachExecution(initialExecution);
  }

  attachExecution(execution: AgentExecution) {
    this.branch.attachExecution(execution);
  }

  current(): ExecutionSnapshot {
    return this.branch.current().getSnapshot();
  }

  currentExecution(): AgentExecution {
    return this.branch.current();
  }

  cancel(reason?: string): void {
    this.branch.current().cancel(reason);
  }
}
