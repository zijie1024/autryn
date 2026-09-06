import { z } from "zod";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const modelIdSchema = z.string().regex(uuidRegex);

export const modelEntrySchema = z.object({
  id: modelIdSchema,
  name: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseURL: z.string().trim().min(1),
  APIKey: z.string().min(1),
  provider: z.enum(["openai", "anthropic"]),
  contextWindowTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().optional(),
  contextCompactionMode: z.enum(["auto", "off"]).optional(),
});

const memoryLayerPolicySchema = z.object({
  access: z.enum(["none", "read", "read_write"]).optional(),
  autoWrite: z.boolean().optional(),
});

const capabilityPolicySchema = z.object({
  toolProfile: z.enum(["coding", "read_only", "none"]).optional(),
  toolAllow: z.array(z.string().min(1)).optional(),
  toolDeny: z.array(z.string().min(1)).optional(),
  approval: z.boolean().optional(),
  skills: z.boolean().optional(),
  todo: z.boolean().optional(),
  projectGuidance: z.boolean().optional(),
  memory: z.object({
    global: memoryLayerPolicySchema.optional(),
    project: memoryLayerPolicySchema.optional(),
  }).optional(),
});

const handoffEdgeSchema = z.object({
  target: idSchema,
  description: z.string().trim().min(1),
});

const delegationEdgeSchema = z.object({
  target: idSchema,
  description: z.string().trim().min(1),
  tools: z.enum(["target", "read_only"]).default("target"),
  memory: z.enum(["target", "read_only", "none"]).default("target"),
  maxSteps: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const agentDefaultsSchema = z.object({
  modelConfigId: modelIdSchema.optional(),
  capabilities: capabilityPolicySchema.optional(),
  maxSteps: z.number().int().positive().optional(),
});

const agentProfileSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  modelConfigId: modelIdSchema.optional(),
  instructions: z.string().trim().min(1).optional(),
  capabilities: capabilityPolicySchema.optional(),
  delegates: z.array(delegationEdgeSchema).default([]),
  handoffs: z.array(handoffEdgeSchema).default([]),
  maxSteps: z.number().int().positive().optional(),
});

const agentGroupSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1),
  entryAgentId: idSchema,
  defaults: agentDefaultsSchema.optional(),
  agents: z.array(agentProfileSchema).min(1),
});

export const autrynConfigSchema = z
  .object({
    models: z.array(modelEntrySchema).min(1),
    agentGroups: z.array(agentGroupSchema).min(1),
    defaultAgentGroupId: idSchema,
    defaultExecutionMode: z.enum(["execute", "dry_run"]),
    contextCompaction: z.object({ summaryModelConfigId: modelIdSchema.optional() }).optional(),
  })
  .superRefine((value, ctx) => {
    const modelIds = new Set<string>();
    const modelNames = new Set<string>();
    for (const [index, model] of value.models.entries()) {
      const name = model.name.normalize("NFC").toLocaleLowerCase();
      if (modelIds.has(model.id)) issue(ctx, ["models", index, "id"], `model id "${model.id}" is duplicated`);
      if (modelNames.has(name)) issue(ctx, ["models", index, "name"], `model name "${model.name}" is duplicated`);
      modelIds.add(model.id);
      modelNames.add(name);
    }
    if (value.contextCompaction?.summaryModelConfigId && !modelIds.has(value.contextCompaction.summaryModelConfigId)) {
      issue(ctx, ["contextCompaction", "summaryModelConfigId"], "summary model is missing");
    }

    const groupIds = new Set<string>();
    const groupNames = new Set<string>();
    for (const [groupIndex, group] of value.agentGroups.entries()) {
      const groupName = group.name.normalize("NFC").toLocaleLowerCase();
      if (groupIds.has(group.id)) issue(ctx, ["agentGroups", groupIndex, "id"], `agent group "${group.id}" is duplicated`);
      if (groupNames.has(groupName)) issue(ctx, ["agentGroups", groupIndex, "name"], `agent group name "${group.name}" is duplicated`);
      groupIds.add(group.id);
      groupNames.add(groupName);
      validateGroup(group, groupIndex, modelIds, ctx);
    }
    if (!groupIds.has(value.defaultAgentGroupId)) {
      issue(ctx, ["defaultAgentGroupId"], `default agent group "${value.defaultAgentGroupId}" is missing`);
    }
  });

function validateGroup(
  group: z.infer<typeof agentGroupSchema>,
  groupIndex: number,
  modelIds: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [agentIndex, agent] of group.agents.entries()) {
    const name = agent.name.normalize("NFC").toLocaleLowerCase();
    if (ids.has(agent.id)) issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex, "id"], `agent "${agent.id}" is duplicated`);
    if (names.has(name)) issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex, "name"], `agent name "${agent.name}" is duplicated`);
    ids.add(agent.id);
    names.add(name);
    const modelId = agent.modelConfigId ?? group.defaults?.modelConfigId;
    if (!modelId || !modelIds.has(modelId)) {
      issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex, "modelConfigId"], `agent "${agent.id}" cannot resolve a model`);
    }
    const defaultCapabilities = group.defaults?.capabilities;
    const toolProfile = agent.capabilities?.toolProfile ?? defaultCapabilities?.toolProfile ?? "coding";
    const approval = agent.capabilities?.approval ?? defaultCapabilities?.approval ?? true;
    const toolAllow = agent.capabilities?.toolAllow ?? defaultCapabilities?.toolAllow;
    const toolDeny = agent.capabilities?.toolDeny ?? defaultCapabilities?.toolDeny;
    const toolMutationConfigured = toolProfile === "coding"
      && ["shell", "write_file", "str_replace", "apply_patch", "mkdir", "move_path"].some((name) =>
        (!toolAllow || toolAllow.includes(name)) && !toolDeny?.includes(name),
      );
    if (toolMutationConfigured && approval === false) {
      issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex, "capabilities", "approval"], "coding tools require Approval Middleware");
    }
    const hasMemoryMutation = (["global", "project"] as const).some((layer) => {
      const access = agent.capabilities?.memory?.[layer]?.access
        ?? defaultCapabilities?.memory?.[layer]?.access
        ?? "read_write";
      const autoWrite = agent.capabilities?.memory?.[layer]?.autoWrite
        ?? defaultCapabilities?.memory?.[layer]?.autoWrite
        ?? true;
      return access === "read_write" && autoWrite;
    });
    if (hasMemoryMutation && approval === false) {
      issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex, "capabilities", "approval"], "memory mutation tools require Approval Middleware");
    }
    for (const layer of ["global", "project"] as const) {
      const access = agent.capabilities?.memory?.[layer]?.access
        ?? defaultCapabilities?.memory?.[layer]?.access
        ?? "read_write";
      const autoWrite = agent.capabilities?.memory?.[layer]?.autoWrite
        ?? defaultCapabilities?.memory?.[layer]?.autoWrite
        ?? true;
      if (autoWrite && access !== "read_write") {
        issue(
          ctx,
          ["agentGroups", groupIndex, "agents", agentIndex, "capabilities", "memory", layer, "autoWrite"],
          `${layer} memory auto-write requires read_write access`,
        );
      }
    }
  }
  if (!ids.has(group.entryAgentId)) {
    issue(ctx, ["agentGroups", groupIndex, "entryAgentId"], `entry Agent "${group.entryAgentId}" is missing`);
  }

  const reachable = new Set<string>([group.entryAgentId]);
  const queue = [group.entryAgentId];
  while (queue.length > 0) {
    const sourceId = queue.shift()!;
    const source = group.agents.find((agent) => agent.id === sourceId);
    if (!source) continue;
    for (const edge of [...source.handoffs, ...source.delegates]) {
      if (!reachable.has(edge.target)) {
        reachable.add(edge.target);
        queue.push(edge.target);
      }
    }
  }

  for (const [agentIndex, agent] of group.agents.entries()) {
    validateEdges(agent.id, "handoffs", agent.handoffs, ids, groupIndex, agentIndex, ctx);
    validateEdges(agent.id, "delegates", agent.delegates, ids, groupIndex, agentIndex, ctx);
    if (agent.id !== group.entryAgentId && !reachable.has(agent.id)) {
      issue(ctx, ["agentGroups", groupIndex, "agents", agentIndex], `agent "${agent.id}" is unreachable from the entry Agent`);
    }
  }
}

function validateEdges(
  source: string,
  key: "handoffs" | "delegates",
  edges: readonly { target: string }[],
  ids: ReadonlySet<string>,
  groupIndex: number,
  agentIndex: number,
  ctx: z.RefinementCtx,
): void {
  const targets = new Set<string>();
  for (const [edgeIndex, edge] of edges.entries()) {
    const path = ["agentGroups", groupIndex, "agents", agentIndex, key, edgeIndex, "target"];
    if (edge.target === source) issue(ctx, path, `agent "${source}" cannot target itself`);
    if (!ids.has(edge.target)) issue(ctx, path, `target Agent "${edge.target}" is missing`);
    if (targets.has(edge.target)) issue(ctx, path, `target Agent "${edge.target}" is duplicated`);
    targets.add(edge.target);
  }
}

function issue(ctx: z.RefinementCtx, path: PropertyKey[], message: string): void {
  ctx.addIssue({ code: "custom", path, message });
}

export type AutrynConfig = z.infer<typeof autrynConfigSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;
export type AgentGroupConfig = z.infer<typeof agentGroupSchema>;
export type AgentProfileConfig = z.infer<typeof agentProfileSchema>;
export type CodingCapabilityPolicy = z.infer<typeof capabilityPolicySchema>;
export type HandoffEdgeConfig = z.infer<typeof handoffEdgeSchema>;
export type DelegationEdgeConfig = z.infer<typeof delegationEdgeSchema>;
