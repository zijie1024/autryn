import path from "node:path";

import {
  createFileMemoryAdapter,
  createMemoryIntegration,
  DEFAULT_MEMORY_LIMITS,
  MemoryService,
  type CodingMemoryRuntime,
  type LayeredMemoryPolicy,
  type MemoryIntegration,
  type MemoryPolicy,
  type MemoryAccess,
  type GlobalMemoryScope,
  type ProjectMemoryScope,
} from "@/memory";
import { globalMemoryScope, projectMemoryScope } from "@/memory";
import { TokenEstimator } from "@/runtime";
import { getAutrynHomePath, projectKeyFromCwd } from "@/sessions";
import { SettingsLoader } from "@/terminal/settings";

export interface TerminalMemoryRuntime extends CodingMemoryRuntime {
  service: MemoryService;
  projectScope: ProjectMemoryScope;
  projectPolicy: MemoryPolicy;
  storageRoot: string;
  integration: MemoryIntegration;
  globalScope: GlobalMemoryScope;
  globalPolicy: MemoryPolicy;
}

/** `/memory` 展示所需的只读状态快照，不包含任何 Document 正文。 */
export interface TerminalMemoryStatus {
  enabled: boolean;
  layers: Array<{
    scope: "global" | "project";
    scopeId: string;
    access: MemoryPolicy["access"];
    autoWrite: boolean;
    storageRoot: string;
    materialized: boolean;
    documents: Array<{ reference: string; digest: string; sizeBytes: number; updatedAt: string }>;
    totalBytes: number;
  }>;
}

/**
 * Terminal 官方组合根：解析 `AUTRYN_HOME`、当前工作区与 Settings，
 * 构造官方 File Adapter 与 MemoryIntegration。Memory 关闭时返回 null。
 */
export async function createTerminalMemoryRuntime(options: {
  cwd: string;
  autrynHome?: string;
}): Promise<TerminalMemoryRuntime | null> {
  const home = options.autrynHome ?? getAutrynHomePath();
  const memorySettings = await new SettingsLoader().loadMemory(options.cwd);
  if (!memorySettings.enabled) {
    return null;
  }

  const projectKey = projectKeyFromCwd(options.cwd);
  const scope = projectMemoryScope(projectKey, options.cwd);
  const globalScope = globalMemoryScope();

  const projectPolicy: MemoryPolicy = {
    access: memorySettings.projectEnabled ? "read_write" : "none",
    autoWrite: memorySettings.projectAutoWrite && memorySettings.autoWrite,
    limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 1_200 },
    failureMode: "best_effort",
  };
  const globalPolicy: MemoryPolicy = {
    ...projectPolicy,
    access: memorySettings.globalEnabled ? "read_write" : "none",
    autoWrite: memorySettings.globalAutoWrite && memorySettings.autoWrite,
    limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 600 },
  };

  const adapter = createFileMemoryAdapter({ home });
  const service = new MemoryService({ adapter, estimator: new TokenEstimator() });
  const rootPolicy: LayeredMemoryPolicy = {
    totalBootstrapTokens: 1_800,
    layers: [
      { name: "global", scope: globalScope, policy: globalPolicy, priority: 100 },
      { name: "project", scope, policy: projectPolicy, priority: 200 },
    ],
  };
  const createIntegration = (layeredPolicy: LayeredMemoryPolicy) =>
    createMemoryIntegration({
      service,
      policy: {
        ...layeredPolicy,
        layers: layeredPolicy.layers.map((layer) => {
          const ceiling = layer.name === "global" ? globalPolicy : projectPolicy;
          return {
            ...layer,
            policy: {
              ...layer.policy,
              access: intersectMemoryAccess(layer.policy.access, ceiling.access),
              autoWrite: layer.policy.autoWrite && ceiling.autoWrite,
            },
          };
        }),
      },
    });
  const integration = createIntegration(rootPolicy);

  return {
    service,
    projectScope: scope,
    projectPolicy,
    storageRoot: path.join(home, "memory", "projects", scope.projectId),
    integration,
    globalScope,
    globalPolicy,
    createIntegration,
  };
}

function intersectMemoryAccess(left: MemoryAccess, right: MemoryAccess): MemoryAccess {
  const rank: Record<MemoryAccess, number> = { none: 0, read: 1, read_write: 2 };
  return rank[left] <= rank[right] ? left : right;
}
