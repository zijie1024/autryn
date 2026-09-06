import type { ExecutionMode, NonSystemMessage } from "@/core";
import type { CompactionNode, ContextCompactionCheckpoint, ContextStateUpdate } from "@/runtime/context";
import type { DryRunReport, HandoffRecord } from "@/runtime/execution/types";

import type { SessionErrorCode } from "./errors";

export type SessionId = string;
export type TurnId = string;
export type SessionMessageId = string;
export type ModelConfigId = string;

export type ModelProviderType = "openai" | "anthropic";

export type TurnStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "limit_exceeded"
  | "interrupted";

export type SessionHealth =
  | "ready"
  | "model_missing"
  | "agent_missing"
  | "cwd_missing"
  | "locked"
  | "corrupted"
  | "clear_pending"
  | "persistence_error";

export interface EffectiveModelSnapshot {
  configId: ModelConfigId;
  configName: string;
  provider: ModelProviderType;
  model: string;
}

export interface PersistedExecutionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageIncomplete?: boolean;
}

export interface PersistedTurnError {
  code: SessionErrorCode | string;
  message: string;
}

export interface PersistedTurn {
  id: TurnId;
  status: TurnStatus;
  startedAt: string;
  finishedAt?: string;
  rootExecutionId?: string;
  executionMode: ExecutionMode;
  initialAgentId: string;
  finalAgentId?: string;
  handoffs: HandoffRecord[];
  dryRunReport?: DryRunReport;
  agentGroupId: string;
  agentGroupRevision: string;
  effectiveModels: Array<EffectiveModelSnapshot & { executionId: string; agentId: string }>;
  usage?: PersistedExecutionUsage;
  error?: PersistedTurnError;
}

export interface PersistedSessionMessage {
  id: SessionMessageId;
  turnId: TurnId;
  committedAt: string;
  message: NonSystemMessage;
}

export interface SessionWorkspace {
  cwd: string;
  projectKey: string;
}

export interface SessionRecord {
  id: SessionId;
  revision: number;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  workspace: SessionWorkspace;
  activeAgentId: string;
  activeAgentGroupId: string;
  agentModelOverrides: Record<string, ModelConfigId>;
  activeExecutionMode: ExecutionMode;
  messages: PersistedSessionMessage[];
  turns: PersistedTurn[];
  compaction: SessionCompactionState;
}

export interface PersistedPhase {
  id: string;
  status: "active" | "completed";
  objective: string;
  startedTurnId: string;
  endedTurnId?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SessionCompactionState {
  version: 1;
  phases: PersistedPhase[];
  nodes: CompactionNode[];
  checkpoint: ContextCompactionCheckpoint;
}

export type { ContextCompactionCheckpoint, ContextStateUpdate };

export interface SessionSummary {
  id: SessionId;
  shortId: string;
  revision: number;
  name: string | null;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  workspace: SessionWorkspace;
  activeAgentGroupId: string;
  activeAgentId: string;
  agentModelOverrides: Record<string, ModelConfigId>;
  health: SessionHealth;
  messageCount: number;
  turnCount: number;
}

export interface SessionLease {
  sessionId: SessionId;
  ownerId: string;
  revision: number;
  release(): Promise<void>;
}

export interface CommitOutcome {
  committed: true;
  revision: number;
  warnings: PublicMaintenanceWarning[];
}

export interface PublicMaintenanceWarning {
  code: string;
  message: string;
}

export interface SessionStore {
  list(options?: { projectKey?: string; includeAllProjects?: boolean }): Promise<SessionSummary[]>;
  load(id: SessionId): Promise<SessionRecord>;
  create(record: SessionRecord): Promise<SessionRecord>;
  mutate(
    id: SessionId,
    reducer: (current: SessionRecord) => SessionRecord | null,
    options?: { operation?: "commit" | "clear" },
  ): Promise<SessionRecord>;
  acquire(id: SessionId, options?: { create?: boolean; force?: boolean }): Promise<SessionLease>;
  deleteSession(id: SessionId): Promise<void>;
}

export interface Clock {
  now(): string;
}

export interface IdFactory {
  sessionId(): SessionId;
  turnId(): TurnId;
  messageId(): SessionMessageId;
  ownerId(): string;
}

export interface DraftSession {
  id: SessionId;
  name: string | null;
  workspace: SessionWorkspace;
  activeAgentId: string;
  activeAgentGroupId: string;
  agentModelOverrides: Record<string, ModelConfigId>;
  activeExecutionMode: ExecutionMode;
  createdAt: string;
  updatedAt: string;
  materialized: false;
}

export type LoadedSession = SessionRecord | DraftSession;
