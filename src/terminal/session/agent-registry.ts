import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import {
  createCodingAgentConfiguration,
  globalApprovalManager,
  globalAskUserQuestionManager,
  type CodingAgentCapabilities,
  type CodingMemory,
} from "@/coding";
import type { NonSystemMessage } from "@/core";
import { DEFAULT_MEMORY_LIMITS, type CodingMemoryRuntime } from "@/memory";
import {
  Agent,
  type AgentConfiguration,
  type ContextManager,
  createPhaseTransitionTool,
  type DelegateDefinition,
  type HandoffDefinition,
  ModelContextSummarizer,
  type AgentRuntime,
  RuntimeContextManager,
} from "@/runtime";
import { SessionError, type ModelConfigId } from "@/sessions";
import type {
  AgentGroupConfig,
  AgentProfileConfig,
  AutrynConfig,
  CodingCapabilityPolicy,
} from "@/terminal/config";
import { SettingsLoader, SettingsWriter } from "@/terminal/settings";

import type { ModelResolver, ResolvedModel } from "./model-resolver";

export interface ResolvedAgentProfile {
  id: string;
  name: string;
  description: string;
  instructions?: string;
  modelConfigId: ModelConfigId;
  capabilities: ResolvedCodingCapabilityPolicy;
  delegates: AgentProfileConfig["delegates"];
  handoffs: AgentProfileConfig["handoffs"];
  maxSteps?: number;
}

export interface FrozenAgentProfile extends ResolvedAgentProfile {
  resolvedModel: ResolvedModel;
}

export interface FrozenAgentGroup {
  id: string;
  name: string;
  entryAgentId: string;
  revision: string;
  agents: ReadonlyMap<string, FrozenAgentProfile>;
}

export interface TerminalAgentFactoryOptions {
  group: FrozenAgentGroup;
  cwd: string;
  messages: NonSystemMessage[];
  contextManager?: ContextManager;
  memoryRuntime?: CodingMemoryRuntime;
  constraints?: AgentCreationConstraints;
  approvalState?: { allowedTools: Set<string> };
  runtime?: AgentRuntime;
  branchKind?: "root" | "delegation";
}

export interface AgentCreationConstraints {
  tools?: "target" | "read_only" | "none";
  memory?: "target" | "read_only" | "none";
}

interface ResolvedCodingCapabilityPolicy {
  toolProfile: "coding" | "read_only" | "none";
  toolAllow?: string[];
  toolDeny?: string[];
  approval: boolean;
  skills: boolean;
  todo: boolean;
  projectGuidance: boolean;
  memory: {
    global: { access: "none" | "read" | "read_write"; autoWrite: boolean };
    project: { access: "none" | "read" | "read_write"; autoWrite: boolean };
  };
}

const DEFAULT_CAPABILITIES: ResolvedCodingCapabilityPolicy = {
  toolProfile: "coding",
  approval: true,
  skills: true,
  todo: true,
  projectGuidance: true,
  memory: {
    global: { access: "read_write", autoWrite: true },
    project: { access: "read_write", autoWrite: true },
  },
};

export class AgentRegistry {
  private readonly groups: ReadonlyMap<string, ResolvedAgentGroup>;

  constructor(
    config: AutrynConfig,
    private readonly modelResolver: ModelResolver,
  ) {
    this.groups = new Map(config.agentGroups.map((group) => [group.id, resolveGroup(group)]));
    this.defaultGroupId = config.defaultAgentGroupId;
  }

  readonly defaultGroupId: string;

  defaultAgentId(): string {
    return this.resolveGroup(this.defaultGroupId).entryAgentId;
  }

  hasGroup(groupId: string): boolean {
    return this.groups.has(groupId);
  }

  hasAgent(groupId: string, agentId: string): boolean {
    return this.groups.get(groupId)?.agents.has(agentId) ?? false;
  }

  resolveGroup(groupId: string): ResolvedAgentGroup {
    const group = this.groups.get(groupId);
    if (!group) throw new SessionError("AGENT_GROUP_NOT_FOUND", `Agent Group ${groupId} is not configured.`);
    return group;
  }

  freeze(groupId: string, overrides: Readonly<Record<string, ModelConfigId>> = {}): FrozenAgentGroup {
    const group = this.resolveGroup(groupId);
    for (const agentId of Object.keys(overrides)) {
      if (!group.agents.has(agentId)) {
        throw new SessionError(
          "SESSION_AGENT_OVERRIDE_INVALID",
          `Model override references Agent ${agentId}, which is not in Group ${groupId}.`,
        );
      }
    }
    const agents = new Map<string, FrozenAgentProfile>();
    for (const profile of group.agents.values()) {
      const modelConfigId = overrides[profile.id] ?? profile.modelConfigId;
      agents.set(profile.id, {
        ...profile,
        modelConfigId,
        resolvedModel: this.modelResolver.resolve(modelConfigId),
      });
    }
    return {
      ...group,
      revision: frozenGroupRevision(group, agents, this.modelResolver.configuration()),
      agents,
    };
  }

  async create(agentId: string, options: TerminalAgentFactoryOptions): Promise<Agent> {
    return new Agent({ ...(await this.createConfiguration(agentId, options)), ...(options.runtime ? { runtime: options.runtime } : {}) });
  }

  async createConfiguration(agentId: string, options: TerminalAgentFactoryOptions): Promise<AgentConfiguration> {
    const profile = options.group.agents.get(agentId);
    if (!profile) throw new SessionError("AGENT_PROFILE_NOT_FOUND", `Agent ${agentId} is not in Group ${options.group.id}.`);

    const settingsLoader = new SettingsLoader();
    const settingsWriter = new SettingsWriter(settingsLoader);
    const capabilities = constrainCapabilities(profile.capabilities, options.constraints);
    const memory = createProfileMemory(options.memoryRuntime, capabilities.memory);
    const handoffs: HandoffDefinition[] = profile.handoffs.map((edge) => ({
      target: edge.target,
      description: edge.description,
      input: codingHandoffInputSchema,
      context: { mode: "continue" as const },
      create: async () => this.createConfiguration(edge.target, {
        ...options,
        messages: [],
      }),
    }));
    const delegates = profile.delegates.map((edge): DelegateDefinition => ({
      name: edge.target,
      description: edge.description,
      create: async () => {
        return this.createConfiguration(edge.target, {
          ...options,
          messages: [],
          contextManager: undefined,
          constraints: { tools: edge.tools, memory: edge.memory },
          branchKind: "delegation",
        });
      },
      policy: {
        tools: { mode: "configured" },
        ...(edge.maxSteps ? { maxSteps: edge.maxSteps } : {}),
        ...(edge.timeoutMs ? { timeoutMs: edge.timeoutMs } : {}),
      },
    }));

    return this.buildConfiguration(profile, options, capabilities, memory, delegates, handoffs, {
      settingsLoader,
      settingsWriter,
    });
  }

  private async buildConfiguration(
    profile: FrozenAgentProfile,
    options: TerminalAgentFactoryOptions,
    capabilities: ResolvedCodingCapabilityPolicy,
    memory: CodingMemory | undefined,
    delegates: DelegateDefinition[],
    handoffs: HandoffDefinition[],
    settings?: { settingsLoader: SettingsLoader; settingsWriter: SettingsWriter },
  ): Promise<AgentConfiguration> {
    const skillsDirs = [
      join(options.cwd, ".agents/skills"),
      join(Bun.env.AUTRYN_HOME!, "skills"),
    ];
    const codingCapabilities: CodingAgentCapabilities = {
      toolProfile: capabilities.toolProfile,
      toolAllow: capabilities.toolAllow,
      toolDeny: capabilities.toolDeny,
      approval: capabilities.approval,
      skills: capabilities.skills,
      todo: capabilities.todo,
      projectGuidance: capabilities.projectGuidance,
    };
    const contextManager = options.contextManager
      ?? createBranchContextManager(options.group, options, this.modelResolver);
    const contextCompactionEnabled = (profile.resolvedModel.entry.contextCompactionMode ?? "auto") !== "off";
    return createCodingAgentConfiguration({
      id: profile.id,
      name: profile.name,
      instructions: [profile.description, profile.instructions].filter(Boolean).join("\n\n"),
      model: profile.resolvedModel.model,
      cwd: options.cwd,
      messages: options.messages,
      contextManager,
      memory,
      delegates,
      handoffs,
      defaultDelegates: false,
      extraTools: contextManager instanceof RuntimeContextManager
        && contextCompactionEnabled
        && options.branchKind !== "delegation"
        ? [createPhaseTransitionTool(contextManager)]
        : [],
      capabilities: codingCapabilities,
      maxSteps: profile.maxSteps,
      skillsDirs,
      askUser: globalApprovalManager.askUser,
      askUserQuestion: globalAskUserQuestionManager.askUserQuestion,
      approvalPersistence: settings
        ? {
            loadAllowList: (cwd) => settings.settingsLoader.loadAllowList(cwd),
            persistAllowedTool: (cwd, toolName) => settings.settingsWriter.appendAllowedTool(cwd, toolName),
          }
        : undefined,
      approvalState: options.approvalState,
    });
  }
}

interface ResolvedAgentGroup {
  id: string;
  name: string;
  entryAgentId: string;
  revision: string;
  agents: ReadonlyMap<string, ResolvedAgentProfile>;
}

function resolveGroup(group: AgentGroupConfig): ResolvedAgentGroup {
  const agents = new Map<string, ResolvedAgentProfile>();
  for (const profile of group.agents) {
    const capabilities = mergeCapabilities(group.defaults?.capabilities, profile.capabilities);
    agents.set(profile.id, {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      ...(profile.instructions ? { instructions: profile.instructions } : {}),
      modelConfigId: (profile.modelConfigId ?? group.defaults?.modelConfigId)!,
      capabilities,
      delegates: profile.delegates,
      handoffs: profile.handoffs,
      ...(profile.maxSteps ?? group.defaults?.maxSteps
        ? { maxSteps: profile.maxSteps ?? group.defaults?.maxSteps }
        : {}),
    });
  }
  const canonical = JSON.stringify({
    id: group.id,
    name: group.name,
    entryAgentId: group.entryAgentId,
    agents: [...agents.values()],
  });
  return {
    id: group.id,
    name: group.name,
    entryAgentId: group.entryAgentId,
    revision: createHash("sha256").update(canonical).digest("hex"),
    agents,
  };
}

function frozenGroupRevision(
  group: ResolvedAgentGroup,
  agents: ReadonlyMap<string, FrozenAgentProfile>,
  config: AutrynConfig,
): string {
  const referencedModelIds = new Set([...agents.values()].map((profile) => profile.modelConfigId));
  const summaryModelConfigId = config.contextCompaction?.summaryModelConfigId;
  if (summaryModelConfigId) referencedModelIds.add(summaryModelConfigId);
  const canonical = JSON.stringify({
    id: group.id,
    name: group.name,
    entryAgentId: group.entryAgentId,
    agents: [...agents.values()].map(({ resolvedModel: _resolvedModel, ...profile }) => profile),
    models: config.models
      .filter((model) => referencedModelIds.has(model.id))
      .map(({ APIKey: _APIKey, ...model }) => model)
      .sort((left, right) => left.id.localeCompare(right.id)),
    contextCompaction: summaryModelConfigId ? { summaryModelConfigId } : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function mergeCapabilities(
  defaults: CodingCapabilityPolicy | undefined,
  profile: CodingCapabilityPolicy | undefined,
): ResolvedCodingCapabilityPolicy {
  return {
    ...DEFAULT_CAPABILITIES,
    ...defaults,
    ...profile,
    memory: {
      global: {
        ...DEFAULT_CAPABILITIES.memory.global,
        ...defaults?.memory?.global,
        ...profile?.memory?.global,
      },
      project: {
        ...DEFAULT_CAPABILITIES.memory.project,
        ...defaults?.memory?.project,
        ...profile?.memory?.project,
      },
    },
  };
}

function constrainCapabilities(
  capabilities: ResolvedCodingCapabilityPolicy,
  constraints: AgentCreationConstraints | undefined,
): ResolvedCodingCapabilityPolicy {
  if (!constraints) return capabilities;
  const toolProfile = intersectToolProfile(capabilities.toolProfile, constraints.tools);
  const memory = {
    global: intersectMemoryPolicy(capabilities.memory.global, constraints.memory),
    project: intersectMemoryPolicy(capabilities.memory.project, constraints.memory),
  };
  return {
    ...capabilities,
    toolProfile,
    memory,
  };
}

export function intersectToolProfile(
  target: ResolvedCodingCapabilityPolicy["toolProfile"],
  edge: AgentCreationConstraints["tools"],
): ResolvedCodingCapabilityPolicy["toolProfile"] {
  if (!edge || edge === "target") return target;
  if (edge === "none") return "none";
  return target === "coding" ? "read_only" : target;
}

export function intersectMemoryPolicy(
  target: ResolvedCodingCapabilityPolicy["memory"]["global"],
  edge: AgentCreationConstraints["memory"],
): ResolvedCodingCapabilityPolicy["memory"]["global"] {
  if (!edge || edge === "target") return target;
  if (edge === "none") return { access: "none", autoWrite: false };
  if (target.access === "read_write") return { access: "read", autoWrite: false };
  return { ...target, autoWrite: false };
}

export const intersectMemoryAccess = intersectMemoryPolicy;

function createProfileMemory(
  runtime: CodingMemoryRuntime | undefined,
  policy: ResolvedCodingCapabilityPolicy["memory"],
): CodingMemory | undefined {
  if (!runtime) return undefined;
  const integration = runtime.createIntegration({
    totalBootstrapTokens: 1_800,
    layers: [
      {
        name: "global",
        scope: runtime.globalScope,
        policy: {
          access: policy.global.access,
          autoWrite: policy.global.autoWrite,
          limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 600 },
          failureMode: "best_effort",
        },
        priority: 100,
      },
      {
        name: "project",
        scope: runtime.projectScope,
        policy: {
          access: policy.project.access,
          autoWrite: policy.project.autoWrite,
          limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 1_200 },
          failureMode: "best_effort",
        },
        priority: 200,
      },
    ],
  });
  return { integration, runtime };
}

const codingHandoffInputSchema = z.object({
  reason: z.string().trim().min(1).max(1_000),
  focus: z.string().trim().min(1).max(2_000).optional(),
});

function createBranchContextManager(
  group: FrozenAgentGroup,
  options: TerminalAgentFactoryOptions,
  modelResolver: ModelResolver,
): RuntimeContextManager | undefined {
  if (![...group.agents.values()].every((profile) => (profile.resolvedModel.entry.contextCompactionMode ?? "auto") === "off")) {
    return new RuntimeContextManager({
      summarizer: new ModelContextSummarizer(group.agents.values().next().value!.resolvedModel.model),
      enabledForModel: (model) => {
        const profile = [...group.agents.values()].find((candidate) => candidate.resolvedModel.model === model);
        return profile ? (profile.resolvedModel.entry.contextCompactionMode ?? "auto") !== "off" : true;
      },
      summarizerForModel: (model) => {
        const profile = [...group.agents.values()].find((candidate) => candidate.resolvedModel.model === model);
        return new ModelContextSummarizer(
          profile ? modelResolver.summaryModel(profile.resolvedModel).model : model,
        );
      },
    });
  }
  return undefined;
}
