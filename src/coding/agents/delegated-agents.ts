import type { ToolUseContent } from "@/core";
import { DEFAULT_MEMORY_LIMITS, type CodingMemoryRuntime } from "@/memory";
import type { AgentConfiguration, DelegateDefinition } from "@/runtime";
import { createSkillsMiddleware } from "@/runtime";

import {
  type ApprovalDecision,
  type ApprovalPersistence,
  createCodingApprovalMiddleware,
} from "../permissions";
import { applyPatchTool } from "../tools/apply-patch";
import { fileInfoTool } from "../tools/file-info";
import { globSearchTool } from "../tools/glob-search";
import { grepSearchTool } from "../tools/grep-search";
import { listFilesTool } from "../tools/list-files";
import { mkdirTool } from "../tools/mkdir";
import { movePathTool } from "../tools/move-path";
import { readFileTool } from "../tools/read-file";
import { createShellTool } from "../tools/shell";
import { strReplaceTool } from "../tools/str-replace";
import { writeFileTool } from "../tools/write-file";

export type CodingDelegateOptions = {
  cwd: string;
  skillsDirs: string[];
  askUser?: (toolUse: ToolUseContent) => Promise<ApprovalDecision>;
  approvalPersistence?: ApprovalPersistence;
  approvalState?: { allowedTools: Set<string> };
  memory?: { runtime: CodingMemoryRuntime };
};

export async function loadProjectGuidance(cwd: string): Promise<string | null> {
  const agentsFile = Bun.file(`${cwd}/AGENTS.md`);
  if (!(await agentsFile.exists())) {
    return null;
  }
  const agentsFileContent = await agentsFile.text();
  return `<project_guidance source="AGENTS.md">\n${agentsFileContent.trim()}\n</project_guidance>`;
}

export function codingPrompt({
  cwd,
  role,
  extraNotes = "",
}: {
  cwd: string;
  role: "leading_agent" | "explore_delegate" | "general_delegate";
  extraNotes?: string;
}) {
  return `<agent name="Autryn" role="${role}" description="A coding agent">
Use the given tools and skills to perform parallel/sequential operations and solve the user's problem in the given working directory.
</agent>

<working_directory dir="${cwd}/" />

<tool_usage>
- Inspect directories before assuming file paths.
- Prefer list_files or glob_search to discover files.
- Prefer grep_search to locate relevant content.
- Read a file before editing it.
- Prefer apply_patch for targeted edits.
- If apply_patch fails, re-read the file and choose a safer edit strategy.
- Do not repeat the same failing tool call with unchanged invalid input.
- Use tool result summaries and error codes to decide the next step.
</tool_usage>

<notes>
- Never try to start a local static server. Let the user do it.
- If the user's input is a simple task or a greeting, you should just respond with a simple answer and then stop.
${extraNotes}
</notes>
`;
}

export function createReadOnlyCodingTools() {
  return [fileInfoTool, listFilesTool, globSearchTool, grepSearchTool, readFileTool];
}

export function createGeneralCodingTools(cwd: string) {
  return [
    createShellTool({ cwd }),
    fileInfoTool,
    listFilesTool,
    globSearchTool,
    grepSearchTool,
    mkdirTool,
    movePathTool,
    readFileTool,
    writeFileTool,
    strReplaceTool,
    applyPatchTool,
  ];
}

export function createCodingDelegates(options: CodingDelegateOptions): DelegateDefinition[] {
  const exploreTools = createReadOnlyCodingTools();
  // general delegate 显式只读两层 Memory：与 root 共享 Scope Identity，但不能修改。
  // Memory Middleware 与 Tool 是无状态的（闭合不可变的 service/scope/policy），
  // 因此可在并行 child 之间安全共享，不携带任何可变缓存。
  const generalMemory = options.memory
    ? options.memory.runtime.createIntegration({
        totalBootstrapTokens: 1_800,
        layers: [
          {
            name: "global",
            scope: options.memory.runtime.globalScope,
            policy: {
              access: "read",
              autoWrite: false,
              limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 600 },
              failureMode: "best_effort",
            },
            priority: 100,
          },
          {
            name: "project",
            scope: options.memory.runtime.projectScope,
            policy: {
              access: "read",
              autoWrite: false,
              limits: { ...DEFAULT_MEMORY_LIMITS, bootstrapTokens: 1_200 },
              failureMode: "best_effort",
            },
            priority: 200,
          },
        ],
      })
    : null;
  const generalTools = [...createGeneralCodingTools(options.cwd), ...(generalMemory ? generalMemory.tools : [])];
  const generalMutationTools = generalTools.filter((tool) => tool.effect.kind === "mutation");

  const explore: DelegateDefinition = {
    name: "explore",
    description: "Read-only codebase exploration, search, evidence gathering, and concise summaries.",
    create: async ({ parentModel }) => {
      const guidance = await loadProjectGuidance(options.cwd);
      return {
        name: "explore",
        model: parentModel,
        prompt: codingPrompt({
        cwd: options.cwd,
        role: "explore_delegate",
        extraNotes: [
          "- You are read-only. Return evidence, file paths, and concise conclusions. Do not modify the workspace.",
          guidance,
        ].filter(Boolean).join("\n\n"),
        }),
        tools: exploreTools,
      };
    },
    policy: {
      tools: { mode: "explicit", tools: exploreTools },
      skills: { mode: "none" },
      delegates: [],
    },
  };

  const general: DelegateDefinition = {
    name: "general",
    description: "A general coding delegate for independent implementation subtasks.",
    create: async ({ parentModel }) => {
      const guidance = await loadProjectGuidance(options.cwd);
      const middlewares = [createSkillsMiddleware(options.skillsDirs)];
      if (generalMemory?.middleware) {
        middlewares.push(generalMemory.middleware);
      }
      if (options.askUser && generalMutationTools.length > 0) {
        middlewares.push(
          createCodingApprovalMiddleware({
            cwd: options.cwd,
            requiresApproval: generalMutationTools.map((tool) => tool.name),
            allowList: options.approvalState?.allowedTools,
            approvalState: options.approvalState,
            askUser: options.askUser,
            approvalPersistence: options.approvalPersistence,
          }),
        );
      }
      return {
        name: "general",
        model: parentModel,
        prompt: codingPrompt({
          cwd: options.cwd,
          role: "general_delegate",
          extraNotes: [
            "- Only handle the delegated task. State modifications, verification, and residual issues in the final response.",
            guidance,
          ].filter(Boolean).join("\n\n"),
        }),
        tools: generalTools,
        middlewares,
      } satisfies AgentConfiguration;
    },
    policy: {
      tools: { mode: "explicit", tools: generalTools },
      skills: { mode: "inherit" },
      delegates: [explore],
    },
  };

  return [explore, general];
}
