import { sha256Hex } from "./hashing";

export type MemoryScope = GlobalMemoryScope | ProjectMemoryScope;

export interface GlobalMemoryScope {
  kind: "global";
  scopeId: "global";
}

export interface ProjectMemoryScope {
  kind: "project";
  scopeId: string;
  projectId: string;
  projectKey: string;
  cwd: string;
}

/** 首次物化 Scope 时写入 `scope.json` 的元数据，仅供一致性校验与人工检查，不进入 Model Context。 */
export type FileMemoryScopeMetadata =
  | {
      schemaVersion: 1;
      kind: "global";
      scopeId: "global";
      createdAt: string;
      updatedAt: string;
    }
  | {
      schemaVersion: 1;
      kind: "project";
      scopeId: string;
      projectId: string;
      projectKey: string;
      createdAt: string;
      updatedAt: string;
    };

/**
 * projectId 是规范化 projectKey 的稳定 SHA-256 Hex。
 * 固定前缀把该算法与其他未来标识算法隔离，避免偶然目录碰撞。
 */
const PROJECT_ID_PREFIX = "autryn-memory-v1\0";

export function projectIdFromProjectKey(projectKey: string): string {
  return sha256Hex(PROJECT_ID_PREFIX + projectKey);
}

export function projectMemoryScope(projectKey: string, cwd: string): ProjectMemoryScope {
  const projectId = projectIdFromProjectKey(projectKey);
  return {
    kind: "project",
    scopeId: projectId,
    projectId,
    projectKey,
    cwd,
  };
}

/** 校验 Project Scope；projectId 必须是未截断的小写十六进制 SHA-256。 */
export function isProjectMemoryScope(scope: unknown): scope is ProjectMemoryScope {
  if (!scope || typeof scope !== "object") return false;
  const value = scope as Partial<ProjectMemoryScope>;
  return (
    value.kind === "project" &&
    value.scopeId === value.projectId &&
    typeof value.projectId === "string" &&
    /^[0-9a-f]{64}$/.test(value.projectId) &&
    typeof value.projectKey === "string" &&
    value.projectKey.length > 0 &&
    typeof value.cwd === "string" &&
    value.cwd.length > 0
  );
}

export function globalMemoryScope(): GlobalMemoryScope {
  return { kind: "global", scopeId: "global" };
}

export function isGlobalMemoryScope(scope: unknown): scope is GlobalMemoryScope {
  if (!scope || typeof scope !== "object") return false;
  const value = scope as Partial<GlobalMemoryScope>;
  return value.kind === "global" && value.scopeId === "global";
}

export function memoryScopeId(scope: MemoryScope): string {
  return scope.scopeId;
}

export function memoryScopeLabel(scope: MemoryScope): "global" | "project" {
  return scope.kind;
}

export function shortMemoryScopeId(scope: MemoryScope): string {
  return isProjectMemoryScope(scope) ? shortProjectId(scope.projectId) : "global";
}

export function shortProjectId(projectId: string): string {
  return projectId.slice(0, 8);
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
