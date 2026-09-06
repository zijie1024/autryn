import z from "zod";

export const settingsSchema = z
  .object({
    permissions: z
      .object({
        allow: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    memory: z
      .object({
        enabled: z.boolean().optional(),
        autoWrite: z.boolean().optional(),
        global: z.object({ enabled: z.boolean().optional(), autoWrite: z.boolean().optional() }).optional(),
        project: z.object({ enabled: z.boolean().optional(), autoWrite: z.boolean().optional() }).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type Settings = z.infer<typeof settingsSchema>;

export interface MemorySettings {
  enabled: boolean;
  autoWrite: boolean;
  globalEnabled: boolean;
  globalAutoWrite: boolean;
  projectEnabled: boolean;
  projectAutoWrite: boolean;
}

/**
 * Memory 使用收紧式合并：`enabled` 与 `autoWrite` 默认均为 true，
 * 任意层显式设置 `false` 后即永久收紧，后续更具体层不能重新提升为 true。
 */
export function resolveMemorySettings(layers: Settings[]): MemorySettings {
  let enabled = true;
  let autoWrite = true;
  let globalEnabled = true;
  let globalAutoWrite = true;
  let projectEnabled = true;
  let projectAutoWrite = true;
  for (const layer of layers) {
    const memory = (layer as Record<string, unknown>).memory;
    if (!memory || typeof memory !== "object" || Array.isArray(memory)) continue;
    const record = memory as Record<string, unknown>;
    if (record.enabled === false) enabled = false;
    if (record.autoWrite === false) autoWrite = false;
    const global = record.global;
    if (global && typeof global === "object" && !Array.isArray(global)) {
      if ((global as Record<string, unknown>).enabled === false) globalEnabled = false;
      if ((global as Record<string, unknown>).autoWrite === false) globalAutoWrite = false;
    }
    const project = record.project;
    if (project && typeof project === "object" && !Array.isArray(project)) {
      if ((project as Record<string, unknown>).enabled === false) projectEnabled = false;
      if ((project as Record<string, unknown>).autoWrite === false) projectAutoWrite = false;
    }
  }
  return { enabled, autoWrite, globalEnabled, globalAutoWrite, projectEnabled, projectAutoWrite };
}

/** 纯函数合并，用于测试以及构建下一次要写入的文档。 */
export function appendToolToAllowList(document: Record<string, unknown>, toolName: string): Record<string, unknown> {
  const permissions =
    document.permissions && typeof document.permissions === "object" && !Array.isArray(document.permissions)
      ? { ...(document.permissions as Record<string, unknown>) }
      : {};
  const rawAllow = permissions.allow;
  const existing: string[] = Array.isArray(rawAllow) ? rawAllow.filter((x): x is string => typeof x === "string") : [];
  const allow = existing.includes(toolName) ? existing : [...existing, toolName];
  return {
    ...document,
    permissions: {
      ...permissions,
      allow,
    },
  };
}
