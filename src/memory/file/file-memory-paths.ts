import path from "node:path";

import { MEMORY_INDEX_REFERENCE } from "../defaults";
import { MemoryError } from "../domain/errors";
import type { MemoryDocumentReference } from "../domain/memory-document";
import type { MemoryScope } from "../domain/memory-scope";

export const MEMORY_DIR = "memory";
export const PROJECTS_DIR = "projects";
export const GLOBAL_DIR = "global";
export const SCOPE_FILENAME = "scope.json";
export const LOCK_FILENAME = ".memory.lock";

const TOPIC_REFERENCE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/;

export function memoryProjectsRoot(home: string): string {
  return path.join(home, MEMORY_DIR, PROJECTS_DIR);
}

export function projectScopeRoot(home: string, projectId: string): string {
  return path.join(memoryProjectsRoot(home), projectId);
}

export function globalScopeRoot(home: string): string {
  return path.join(home, MEMORY_DIR, GLOBAL_DIR);
}

/** 按 Scope 解析统一的存储根目录，调用方不需要分支访问 projectId。 */
export function scopeRoot(home: string, scope: MemoryScope): string {
  if (scope.kind === "global") return globalScopeRoot(home);
  if (scope.kind === "project") return projectScopeRoot(home, scope.projectId);
  throw new MemoryError("MEMORY_SCOPE_INVALID", "Invalid memory scope.");
}

export function scopeMetadataPath(home: string, scope: MemoryScope): string {
  return path.join(scopeRoot(home, scope), SCOPE_FILENAME);
}

export function scopeLockPath(home: string, scope: MemoryScope): string {
  return path.join(scopeRoot(home, scope), LOCK_FILENAME);
}

export function scopeDocumentPath(home: string, scope: MemoryScope, reference: MemoryDocumentReference): string {
  return resolveReferencePath(scopeRoot(home, scope), reference);
}

/**
 * 校验并规范化一个 Reference。索引固定为 `MEMORY.md`；Topic 使用小写 kebab-case + `.md`。
 * 拒绝绝对路径、父目录、路径分隔符、隐藏文件、非 Markdown 扩展名，以及
 * 大小写折叠后与索引碰撞的名称。
 */
export function parseReference(raw: string): MemoryDocumentReference {
  if (raw === MEMORY_INDEX_REFERENCE) return raw;
  if (!TOPIC_REFERENCE.test(raw)) {
    throw new MemoryError(
      "MEMORY_REFERENCE_INVALID",
      `Invalid memory reference "${raw}". Topic documents use lowercase kebab-case with a .md extension.`,
    );
  }
  if (raw.toLowerCase() === MEMORY_INDEX_REFERENCE.toLowerCase()) {
    throw new MemoryError(
      "MEMORY_REFERENCE_INVALID",
      `Invalid memory reference "${raw}": the name collides with the reserved ${MEMORY_INDEX_REFERENCE} index.`,
    );
  }
  return raw as MemoryDocumentReference;
}

/**
 * 把 Reference 解析为 Scope Root 下的绝对路径，并验证最终位置仍在 Root 内。
 * 实现不依赖字符串替换阻止路径穿越，而是用 path.resolve/relative 判定。
 */
export function resolveReferencePath(scopeRoot: string, reference: MemoryDocumentReference): string {
  const parsed = parseReference(reference);
  const resolvedRoot = path.resolve(scopeRoot);
  const resolved = path.resolve(resolvedRoot, parsed);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MemoryError("MEMORY_REFERENCE_INVALID", `Reference ${reference} escapes the memory scope.`);
  }
  return resolved;
}
