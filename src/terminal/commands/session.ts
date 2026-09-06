import type { Command } from "commander";

import {
  FileSessionStore,
  normalizeSessionName,
  projectKeyFromCwd,
  publicErrorMessage,
  resolveSessionSelector,
  type SessionSummary,
} from "@/sessions";
import { ensureAutrynHomeEnv, loadConfig } from "@/terminal/config";
import { AgentRegistry, ModelResolver } from "@/terminal/session";

export function registerSessionCommands(program: Command): void {
  const session = program.command("session").description("Manage saved Autryn sessions");

  session
    .command("list")
    .description("List saved sessions")
    .option("--all", "Include sessions from every project")
    .option("--json", "Print stable JSON")
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      await runSessionCommand(async () => {
        const store = new FileSessionStore();
        const config = loadConfig();
        const modelResolver = new ModelResolver(config);
        const registry = new AgentRegistry(config, modelResolver);
        const sessions = (
          await store.list({ includeAllProjects: opts.all, projectKey: projectKeyFromCwd(process.cwd()) })
        ).map((summary) => withConfigurationHealth(summary, registry));
        if (opts.json) {
          console.info(JSON.stringify({ sessions: sessions.map(toJsonSummary) }, null, 2));
          return;
        }
        if (sessions.length === 0) {
          console.info("No saved sessions.");
          return;
        }
        for (const item of sessions) {
          console.info(`${item.shortId}  ${item.displayName}  ${item.updatedAt || "(unknown time)"}  ${item.health}`);
          console.info(`    cwd: ${item.workspace.cwd || "(unknown)"}`);
          console.info(`    Agent Group: ${item.activeAgentGroupId}`);
          console.info(`    active Agent: ${item.activeAgentId}`);
        }
      });
    });

  session
    .command("show <selector>")
    .description("Show saved session metadata without printing the transcript")
    .option("--json", "Print stable JSON")
    .action(async (selector: string, opts: { json?: boolean }) => {
      await runSessionCommand(async () => {
        const store = new FileSessionStore();
        const config = loadConfig();
        const modelResolver = new ModelResolver(config);
        const registry = new AgentRegistry(config, modelResolver);
        const target = resolveSessionSelector(selector, await store.list({ includeAllProjects: true }));
        const record = await store.load(target.id);
        const summary = toJsonSummary(
          withConfigurationHealth(
            {
              ...target,
              revision: record.revision,
              name: record.name,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              workspace: record.workspace,
              activeAgentGroupId: record.activeAgentGroupId,
              activeAgentId: record.activeAgentId,
              agentModelOverrides: record.agentModelOverrides,
              messageCount: record.messages.length,
              turnCount: record.turns.length,
            },
            registry,
          ),
        );
        if (opts.json) {
          console.info(JSON.stringify({ session: summary }, null, 2));
          return;
        }
        console.info(`${summary.shortId}  ${summary.displayName}`);
        console.info(`id: ${summary.id}`);
        console.info(`cwd: ${summary.workspace.cwd}`);
        console.info(`Agent Group: ${summary.activeAgentGroupId}`);
        console.info(`active Agent: ${summary.activeAgentId}`);
        console.info(`messages: ${summary.messageCount}`);
        console.info(`turns: ${summary.turnCount}`);
        console.info(`updated: ${summary.updatedAt}`);
      });
    });

  session
    .command("rename <selector> <name>")
    .description("Rename one saved session")
    .action(async (selector: string, name: string) => {
      await runSessionCommand(async () => {
        const store = new FileSessionStore();
        const target = resolveSessionSelector(selector, await store.list({ includeAllProjects: true }));
        const lease = await store.acquire(target.id);
        try {
          const current = await store.load(target.id);
          const next = {
            ...current,
            revision: current.revision + 1,
            name: normalizeSessionName(name),
            updatedAt: new Date().toISOString(),
          };
          await store.commit(lease, current.revision, next);
          console.info(`Renamed ${target.shortId} to "${next.name}".`);
        } finally {
          await lease.release();
        }
      });
    });

  session
    .command("delete <selector>")
    .description("Permanently delete one saved session")
    .requiredOption("--yes", "Confirm permanent deletion")
    .action(async (selector: string) => {
      await runSessionCommand(async () => {
        const store = new FileSessionStore();
        const target = resolveSessionSelector(selector, await store.list({ includeAllProjects: true }));
        const lease = await store.acquire(target.id);
        try {
          await store.delete(lease, target.id);
          console.info(`Deleted session ${target.shortId}.`);
        } finally {
          await lease.release().catch(() => {});
        }
      });
    });

  session
    .command("unlock <selector>")
    .description("Force-release a stale session lease after explicit confirmation")
    .requiredOption("--force", "Force unlock the selected session")
    .action(async (selector: string) => {
      await runSessionCommand(async () => {
        const store = new FileSessionStore();
        const target = resolveSessionSelector(selector, await store.list({ includeAllProjects: true }));
        const lease = await store.acquire(target.id, { force: true });
        await lease.release();
        console.info(`Unlocked session ${target.shortId}.`);
      });
    });
}

async function runSessionCommand(fn: () => Promise<void>) {
  ensureAutrynHomeEnv();
  try {
    await fn();
  } catch (error) {
    console.error(publicErrorMessage(error));
    process.exit(1);
  }
}

function toJsonSummary(summary: SessionSummary) {
  return {
    id: summary.id,
    shortId: summary.shortId,
    name: summary.name,
    displayName: summary.displayName,
    revision: summary.revision,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    workspace: summary.workspace,
    activeAgentGroupId: summary.activeAgentGroupId,
    activeAgentId: summary.activeAgentId,
    agentModelOverrides: summary.agentModelOverrides,
    health: summary.health,
    messageCount: summary.messageCount,
    turnCount: summary.turnCount,
  };
}

function withConfigurationHealth(summary: SessionSummary, registry: AgentRegistry): SessionSummary {
  if (summary.health !== "ready" && summary.health !== "cwd_missing") return summary;
  if (!registry.hasGroup(summary.activeAgentGroupId)) return { ...summary, health: "agent_missing" };
  if (!registry.hasAgent(summary.activeAgentGroupId, summary.activeAgentId)) {
    return { ...summary, health: "agent_missing" };
  }
  try {
    registry.freeze(summary.activeAgentGroupId, summary.agentModelOverrides);
    return summary;
  } catch {
    return { ...summary, health: "model_missing" };
  }
}
