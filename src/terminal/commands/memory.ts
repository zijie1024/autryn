import path from "node:path";

import type { Command } from "commander";

import {
  createFileMemoryAdapter,
  globalMemoryScope,
  MemoryService,
  projectMemoryScope,
  shortDigest,
  type MemoryDocumentReference,
  type MemoryPolicy,
  type MemoryScope,
} from "@/memory";
import { TokenEstimator } from "@/runtime";
import { getAutrynHomePath, projectKeyFromCwd } from "@/sessions";
import { ensureAutrynHomeEnv } from "@/terminal/config";

const READ_POLICY: MemoryPolicy = {
  access: "read",
  autoWrite: false,
  limits: { bootstrapTokens: 1_200, maxDocumentBytes: 64 * 1024, maxDocumentsPerScope: 64, maxScopeBytes: 2 * 1024 * 1024 },
  failureMode: "best_effort",
};

type ScopeOption = "global" | "project" | "all";

export function registerMemoryCommands(program: Command): void {
  const memory = program.command("memory").description("Inspect Global and Project Memory");

  memory
    .command("list")
    .description("List memory documents by scope")
    .option("--scope <scope>", "global, project, or all", "all")
    .option("--json", "Print stable JSON")
    .action(async (options: { scope: string; json?: boolean }) => runMemoryCommand(async () => {
      const scopeOption = parseScope(options.scope, true);
      const context = memoryContext();
      const scopes = scopeOption === "all" ? [context.global, context.project] : [selectScope(context, scopeOption)];
      const groups = await Promise.all(scopes.map(async (scope) => {
        const snapshot = await context.service.inspect(scope, READ_POLICY);
        return {
          scope: scope.kind,
          scopeId: scope.scopeId,
          materialized: snapshot.materialized,
          documents: snapshot.documents.map((document) => ({
            reference: document.reference,
            digest: shortDigest(document.digest),
            sizeBytes: document.sizeBytes,
            updatedAt: document.updatedAt,
          })),
          totalBytes: snapshot.totalBytes,
        };
      }));
      if (options.json) {
        console.info(JSON.stringify({ scopes: groups }, null, 2));
        return;
      }
      for (const group of groups) {
        console.info(`${group.scope === "global" ? "Global" : "Project"} Memory (${group.scopeId})`);
        if (group.documents.length === 0) console.info("  No memory documents.");
        for (const document of group.documents) {
          console.info(`  ${document.reference}  ${document.sizeBytes}B  ${document.digest}  ${document.updatedAt}`);
        }
      }
    }));

  memory
    .command("show <reference>")
    .requiredOption("--scope <scope>", "global or project")
    .description("Show one memory document from an explicit scope")
    .action(async (reference: string, options: { scope: string }) => runMemoryCommand(async () => {
      const context = memoryContext();
      const scope = selectScope(context, parseScope(options.scope, false) as Exclude<ScopeOption, "all">);
      const document = await context.service.view(scope, READ_POLICY, reference as MemoryDocumentReference);
      console.info(document.content.replace(/\n$/, ""));
    }));

  memory
    .command("path")
    .requiredOption("--scope <scope>", "global or project")
    .description("Print the local directory for an explicit memory scope")
    .action(async (options: { scope: string }) => runMemoryCommand(async () => {
      const context = memoryContext();
      const scope = selectScope(context, parseScope(options.scope, false) as Exclude<ScopeOption, "all">);
      console.info(scope.kind === "global"
        ? path.join(getAutrynHomePath(), "memory", "global")
        : path.join(getAutrynHomePath(), "memory", "projects", scope.projectId));
    }));
}

function memoryContext() {
  const project = projectMemoryScope(projectKeyFromCwd(process.cwd()), process.cwd());
  const global = globalMemoryScope();
  const service = new MemoryService({
    adapter: createFileMemoryAdapter({ home: getAutrynHomePath() }),
    estimator: new TokenEstimator(),
  });
  return { service, global, project };
}

function selectScope(
  context: ReturnType<typeof memoryContext>,
  scope: Exclude<ScopeOption, "all">,
): MemoryScope {
  return scope === "global" ? context.global : context.project;
}

function parseScope(raw: string, allowAll: boolean): ScopeOption {
  if (raw === "global" || raw === "project" || (allowAll && raw === "all")) return raw;
  throw new Error(`Invalid memory scope "${raw}".`);
}

async function runMemoryCommand(fn: () => Promise<void>) {
  ensureAutrynHomeEnv();
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***"));
    process.exitCode = 1;
  }
}
