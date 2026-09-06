import { join } from "path";

import type { Model, NonSystemMessage, Tool, ToolUseContent } from "@/core";
import type { CodingMemoryRuntime, MemoryIntegration } from "@/memory";
import {
  Agent,
  type AgentConfiguration,
  type AgentRuntime,
  type ContextManager,
  createSkillsMiddleware,
  createTodoSystem,
  type DelegateDefinition,
  type HandoffDefinition,
} from "@/runtime";

import {
  type ApprovalDecision,
  type ApprovalPersistence,
  createCodingApprovalMiddleware,
} from "../permissions";
import {
  type AskUserQuestionParameters,
  type AskUserQuestionResult,
  createAskUserQuestionTool,
} from "../tools/ask-user-question";

import {
  codingPrompt,
  createCodingDelegates,
  createGeneralCodingTools,
  createReadOnlyCodingTools,
  loadProjectGuidance,
} from "./delegated-agents";

/**
 * 交给 Coding Agent 的 Memory 组合：root 使用 `integration`，
 * `service` 与 `scope` 用于为官方 delegate 组装各自的 Memory 能力。
 */
export interface CodingMemory {
  integration: MemoryIntegration;
  runtime: CodingMemoryRuntime;
}

export interface CodingAgentCapabilities {
  toolProfile?: "coding" | "read_only" | "none";
  toolAllow?: readonly string[];
  toolDeny?: readonly string[];
  approval?: boolean;
  skills?: boolean;
  todo?: boolean;
  projectGuidance?: boolean;
}

export interface CodingApprovalState {
  allowedTools: Set<string>;
}

export async function createCodingAgentConfiguration({
  id = "code",
  name = "Code Agent",
  instructions,
  model,
  cwd = process.cwd(),
  skillsDirs = [join(process.cwd(), ".agents/skills")],
  askUser,
  askUserQuestion,
  approvalPersistence,
  approvalState,
  delegates,
  handoffs = [],
  defaultDelegates = true,
  messages: transcript = [],
  contextManager,
  extraTools = [],
  memory,
  capabilities = {},
  maxSteps,
}: {
  id?: string;
  name?: string;
  instructions?: string;
  model: Model;
  cwd?: string;
  messages?: NonSystemMessage[];
  extraTools?: Tool[];
  skillsDirs?: string[];
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  askUserQuestion?: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>;
  approvalPersistence?: ApprovalPersistence;
  approvalState?: CodingApprovalState;
  runtime?: AgentRuntime;
  delegates?: DelegateDefinition[];
  handoffs?: HandoffDefinition[];
  defaultDelegates?: boolean;
  contextManager?: ContextManager;
  memory?: CodingMemory;
  capabilities?: CodingAgentCapabilities;
  maxSteps?: number;
}): Promise<AgentConfiguration> {
  const useGuidance = capabilities.projectGuidance ?? true;
  const messages: NonSystemMessage[] = [...transcript];
  const projectGuidance = useGuidance ? await loadProjectGuidance(cwd) : null;
  const { tool: todoTool, middleware: todoMiddleware } = createTodoSystem();

  const askUserQuestionTool = askUserQuestion ? createAskUserQuestionTool(askUserQuestion) : null;

  // 固定顺序：Skills → Memory → Todo → Approval。
  const middlewares: NonNullable<AgentConfiguration["middlewares"]> = [];
  if (capabilities.skills ?? true) middlewares.push(createSkillsMiddleware(skillsDirs));
  if (memory?.integration.middleware) {
    middlewares.push(memory.integration.middleware);
  }
  if (capabilities.todo ?? true) middlewares.push(todoMiddleware);
  const configuredDelegates = [
    ...(defaultDelegates
      ? createCodingDelegates({
          cwd,
          skillsDirs,
          askUser,
          approvalPersistence,
          approvalState,
          memory,
        })
      : []),
    ...(delegates ?? []),
  ];

  const profile = capabilities.toolProfile ?? "coding";
  const baseTools = profile === "coding"
    ? createGeneralCodingTools(cwd)
    : profile === "read_only"
      ? createReadOnlyCodingTools()
      : [];
  const allowed = capabilities.toolAllow ? new Set(capabilities.toolAllow) : null;
  const denied = new Set(capabilities.toolDeny ?? []);
  const selectedTools = baseTools.filter((tool) => (!allowed || allowed.has(tool.name)) && !denied.has(tool.name));
  const configuredTools = [
    ...selectedTools,
    ...((capabilities.todo ?? true) ? [todoTool] : []),
    ...(memory ? memory.integration.tools : []),
    ...extraTools,
    ...(askUserQuestionTool ? [askUserQuestionTool] : []),
  ];
  const mutationTools = configuredTools.filter((tool) => tool.effect.kind === "mutation");
  if (mutationTools.length > 0 && (capabilities.approval ?? true) && askUser) {
    middlewares.push(
      createCodingApprovalMiddleware({
        cwd,
        requiresApproval: mutationTools.map((tool) => tool.name),
        allowList: approvalState?.allowedTools,
        approvalState,
        askUser,
        approvalPersistence,
      }),
    );
  }
  if (
    mutationTools.length > 0 &&
    (!(capabilities.approval ?? true) || !askUser)
  ) {
    throw new Error("Coding mutation tools require an active Approval Middleware.");
  }

  return {
    id,
    name,
    model,
    prompt: codingPrompt({
      cwd,
      role: "leading_agent",
      extraNotes: [instructions, projectGuidance].filter(Boolean).join("\n\n"),
    }),
    messages,
    tools: configuredTools,
    middlewares,
    delegates: configuredDelegates,
    handoffs,
    contextManager,
    ...(maxSteps ? { maxSteps } : {}),
  };
}

export async function createCodingAgent(
  options: Parameters<typeof createCodingAgentConfiguration>[0],
): Promise<Agent> {
  return new Agent({
    ...(await createCodingAgentConfiguration(options)),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
}
