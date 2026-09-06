import { join } from "node:path";

import { Command } from "commander";
import { render } from "ink";

import { FileSessionStore, projectKeyFromCwd, resolveSessionSelector } from "@/sessions";
import { validateIntegrity } from "@/terminal/bootstrap";
import { registerCommands } from "@/terminal/commands";
import { formatConfigLoadError, getConfigFilePath, loadConfig, saveConfig } from "@/terminal/config";
import { AgentRegistry, ModelResolver, SessionController } from "@/terminal/session";

import { App } from "./tui";
import { loadAvailableCommands, type SlashCommand } from "./tui/command-registry";
import { AgentLoopProvider } from "./tui/hooks/use-agent-loop";
import { AUTRYN_NAME, AUTRYN_VERSION } from "./version";

const program = new Command();
program
  .name(AUTRYN_NAME)
  .description("Autryn — a lightweight, extensible AI Agent Runtime")
  .version(AUTRYN_VERSION, "-v, --version")
  .option("--continue", "Resume the latest saved session for the current project")
  .option("--resume <selector>", "Resume a saved session by id, id prefix or exact name")
  .option("--dry-run", "Start a new session draft in dry-run mode");

registerCommands(program);

const args = process.argv.slice(2);

if (shouldRunCommanderOnly(args)) {
  await program.parseAsync(process.argv);
} else {
  await launchTui(parseRootLaunchOptions(args));
}

async function launchTui(options: { continue?: boolean; resume?: string; dryRun?: boolean }) {
  console.info();
  await validateIntegrity();

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    saveConfig(config);
  } catch (err) {
    console.error(formatConfigLoadError(err, getConfigFilePath()));
    process.exit(1);
  }

  const store = new FileSessionStore();
  const modelResolver = new ModelResolver(config);
  const agentRegistry = new AgentRegistry(config, modelResolver);
  const cwd = process.cwd();
  let session = undefined;
  let sessionLease = undefined;

  if (options.continue && options.resume) {
    console.error("Use either --continue or --resume, not both.");
    process.exit(1);
  }
  if (options.continue) {
    const projectKey = projectKeyFromCwd(cwd);
    const sessions = await store.list({ projectKey });
    const latest = sessions.find(
      (item) =>
        item.health === "ready" &&
        isRunnableSessionSummary(agentRegistry, item),
    );
    if (!latest) {
      console.error(
        "No saved session found for this project. Start `autryn` for a new draft or use --resume <selector>.",
      );
      process.exit(1);
    }
    session = await store.load(latest.id);
    sessionLease = await store.acquire(latest.id);
  } else if (options.resume) {
    const target = resolveSessionSelector(options.resume, await store.list({ includeAllProjects: true }));
    session = await store.load(target.id);
    if (!isRunnableSessionSummary(agentRegistry, { ...target, agentModelOverrides: session.agentModelOverrides })) {
      console.error("The selected session references an unavailable Agent Group, Agent, or Model configuration.");
      process.exit(1);
    }
    sessionLease = await store.acquire(target.id);
  }

  const controller = new SessionController({
    store,
    modelResolver,
    cwd,
    session,
    lease: sessionLease,
    agentRegistry,
    configurationSource: {
      loadTurnConfiguration: () => {
        const nextConfig = loadConfig();
        const nextResolver = new ModelResolver(nextConfig);
        return { modelResolver: nextResolver, agentRegistry: new AgentRegistry(nextConfig, nextResolver) };
      },
    },
    initialExecutionMode: !session && options.dryRun ? "dry_run" : config.defaultExecutionMode,
  });
  const dispose = () => {
    void controller.dispose();
  };
  process.once("exit", dispose);
  process.once("SIGINT", () => {
    void controller.dispose().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void controller.dispose().finally(() => process.exit(143));
  });
  const sessionCwd = controller.snapshot().cwd;
  const skillsDirs = [
    join(sessionCwd, ".agents/skills"),
    join(Bun.env.AUTRYN_HOME!, "skills"),
  ];
  const commands: SlashCommand[] = await loadAvailableCommands(skillsDirs);

  render(
    <AgentLoopProvider sessionController={controller} commands={commands}>
      <App commands={commands} supportProjectWideAllow />
    </AgentLoopProvider>,
    { patchConsole: false },
  );
}

function isRunnableSessionSummary(
  registry: AgentRegistry,
  session: { activeAgentGroupId: string; activeAgentId: string; agentModelOverrides: Record<string, string> },
): boolean {
  if (!registry.hasGroup(session.activeAgentGroupId)) return false;
  if (!registry.hasAgent(session.activeAgentGroupId, session.activeAgentId)) return false;
  try {
    registry.freeze(session.activeAgentGroupId, session.agentModelOverrides);
    return true;
  } catch {
    return false;
  }
}

function shouldRunCommanderOnly(args: string[]): boolean {
  const first = args[0];
  if (!first) return false;
  if (first === "--continue" || first === "--resume" || first === "--dry-run") return false;
  if (first === "--help" || first === "-h" || first === "--version" || first === "-v") return true;
  return !first.startsWith("-");
}

function parseRootLaunchOptions(args: string[]): { continue?: boolean; resume?: string; dryRun?: boolean } {
  const options: { continue?: boolean; resume?: string; dryRun?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--continue") {
      options.continue = true;
    } else if (arg === "--resume") {
      const selector = args[i + 1];
      if (!selector) {
        console.error("--resume requires a selector.");
        process.exit(1);
      }
      options.resume = selector;
      i++;
    } else if (arg?.startsWith("--resume=")) {
      options.resume = arg.slice("--resume=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }
  return options;
}
