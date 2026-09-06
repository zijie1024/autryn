> [English Version](./README.md) — [中文版本](./README.zh.md)

# Autryn

<p>
  <a href="https://bun.com"><img src="https://img.shields.io/badge/Bun-000000?logo=bun&amp;logoColor=ffffff" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=ffffff" alt="TypeScript"></a>
  <a href="https://github.com/vadimdemedes/ink"><img src="https://img.shields.io/badge/Ink-000000?logo=npm&amp;logoColor=ffffff" alt="Ink"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-61DAFB?logo=react&amp;logoColor=000000" alt="React"></a>
</p>

Autryn is a local AI Agent Runtime. It provides a reusable Agent Loop, Provider abstractions, a Coding Agent, persistent Sessions, layered Memory, Agent Delegation, Handoff, and an interactive terminal interface.

The name `Autryn` brings together autonomy and runtime, reflecting its purpose: providing a reliable, extensible runtime for autonomous Agents.

You can install the Autryn CLI directly from GitHub with npm, or build it from source for development and contribution.

## Table of contents

- [Features](#features)
- [Quick start](#quick-start)
- [Installation](#installation)
- [Model configuration](#model-configuration)
- [CLI usage](#cli-usage)
- [Session management](#session-management)
- [Agent capabilities](#agent-capabilities)
- [Project structure](#project-structure)
- [Use as a library](#use-as-a-library)
- [Development](#development)
- [Current limitations](#current-limitations)
- [Roadmap](#roadmap)

## Features

- **Unified model abstraction**: Connect to OpenAI, Anthropic, and compatible services through the `Model` and Provider interfaces.
- **Coding Agent**: Use built-in development Tools for file operations, search, patching, and command execution.
- **Persistent Sessions**: Create, resume, rename, clear, and delete Sessions, or inspect Sessions across projects.
- **Context compaction**: Build bounded Model input for long conversations from an explicit Model Context Window while preserving the complete Session.
- **Model switching**: Set a Model per Agent within the same Session. The change takes effect on the next request and does not interrupt a running task.
- **Global and Project Memory**: Store reusable long-term knowledge in two independent Scopes with scoped access, explicit writes, and dry-run Previews.
- **Skill loading**: Discover and load Agent Skills from `AUTRYN_HOME` and the project directory.
- **Agent Delegation**: Delegate subtasks to other Agents registered with the same Runtime through a controlled Delegation mechanism.
- **Agent Handoff**: Transfer control to a configured successor Agent within the same Execution Branch while preserving Session continuity.
- **dry-run**: Produce Tool and Memory Mutation Previews across the Execution Tree without committing changes.
- **Interactive TUI**: Work through a terminal interface built with Ink and React.

## Quick start

Install globally from GitHub with npm:

```bash
npm install -g github:zijie1024/autryn#v0.1.0
```

Open the project that you want Autryn to work on, then start the CLI.

Windows PowerShell:

```powershell
Set-Location C:\path\to\your\project
autryn
```

macOS / Linux:

```bash
cd /path/to/your/project
autryn
```

This project directory is the Autryn workspace, not the Autryn source directory. Autryn uses the current directory as the basis for file operations, command execution, project-level Skill discovery, and Session ownership.

On first launch, the CLI guides you through adding a model configuration.

## Installation

### Install from GitHub with npm

The following command installs Autryn from its GitHub repository rather than the npm registry. The package provides the global `autryn` command. On first run, the launcher downloads the matching GitHub Release binary for the current operating system and CPU architecture.

Before installing, make sure Node.js 20 or later, npm, and Git are available.

```bash
npm install -g github:zijie1024/autryn#v0.1.0
```

The binary is cached under the current user's Home directory by default:

| System  | Cache directory                            |
| ------- | ------------------------------------------ |
| Windows | `%USERPROFILE%\.autryn\bin\<version>\`     |
| macOS   | `/Users/<username>/.autryn/bin/<version>/` |
| Linux   | `/home/<username>/.autryn/bin/<version>/`  |

This cache location always uses the current user's Home directory and is not affected by `AUTRYN_HOME`.

After installation, run `autryn` from any target project directory. The current working directory becomes the Autryn workspace.

Supported Release asset names:

| System  | Architecture | Release asset            |
| ------- | ------------ | ------------------------ |
| Windows | x64          | `autryn-win32-x64.exe`   |
| Windows | arm64        | `autryn-win32-arm64.exe` |
| macOS   | x64          | `autryn-darwin-x64`      |
| macOS   | arm64        | `autryn-darwin-arm64`    |
| Linux   | x64          | `autryn-linux-x64`       |
| Linux   | arm64        | `autryn-linux-arm64`     |

### Install the Library from a GitHub Release

Each GitHub Release also provides an installable `autryn-<version>.tgz` package. For example:

```bash
npm install https://github.com/zijie1024/autryn/releases/download/v0.1.0/autryn-0.1.0.tgz
```

The Library uses Bun APIs and therefore requires the Bun Runtime when running TypeScript or JavaScript integrations. The standalone CLI binary does not require Bun.

The default download location is determined by `autryn.releaseRepository` in the package's `package.json`. To use another repository or mirror, set one of these environment variables:

- `AUTRYN_RELEASE_REPOSITORY`: A GitHub repository in `<owner>/<repository>` format.
- `AUTRYN_RELEASE_BASE_URL`: The complete base URL that contains the Release assets, such as `https://example.com/autryn/v0.1.0`. This setting takes precedence over the repository configuration.

### Build from source for development

Building from source is an alternative for development and contribution. It is not required after a global installation. Open the Autryn source directory, install the dependencies, and build the binary for the current platform:

```bash
bun install
bun run build:bin
```

After the build completes, open the target project directory and run the generated binary.

macOS / Linux:

```bash
cd /path/to/your/project
/path/to/autryn/dist/bin/autryn
```

Windows PowerShell:

```powershell
Set-Location C:\path\to\your\project
& C:\path\to\autryn\dist\bin\autryn.exe
```

Use `--help` to view command help. On first launch, the CLI guides you through adding a model configuration.

## Model configuration

Autryn stores its configuration under the current user's Home directory by default:

| System  | Default path                            |
| ------- | --------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\config.yaml`     |
| macOS   | `/Users/<username>/.autryn/config.yaml` |
| Linux   | `/home/<username>/.autryn/config.yaml`  |

When `AUTRYN_HOME` is set, Autryn stores the configuration in `config.yaml` under that directory:

| System        | Path                        |
| ------------- | --------------------------- |
| Windows       | `<AUTRYN_HOME>\config.yaml` |
| macOS / Linux | `<AUTRYN_HOME>/config.yaml` |

Set the variable for the current Shell session:

Windows PowerShell:

```powershell
$env:AUTRYN_HOME = "D:\AutrynData"
```

macOS / Linux:

```bash
export AUTRYN_HOME="$HOME/.autryn-data"
```

### Provider types

Model configuration offers four Provider options:

| Configuration option            | Provider type | Base URL                               |
| ------------------------------- | ------------- | -------------------------------------- |
| `Anthropic (Official)`          | `anthropic`   | Anthropic's official endpoint          |
| `OpenAI (Official)`             | `openai`      | `https://api.openai.com/v1`            |
| `Anthropic-compatible (Custom)` | `anthropic`   | A custom Anthropic-compatible endpoint |
| `OpenAI-compatible (Custom)`    | `openai`      | A custom OpenAI-compatible endpoint    |

`Official` uses the service provider's official endpoint. `Custom` connects to a service that follows the corresponding API format. A custom Base URL must be a complete `http` or `https` URL. API Keys are masked in configuration lists and related interfaces.

### List models

```bash
autryn config model list
```

### Add a model

```bash
autryn config model add
```

The setup flow asks for the Provider type, model name, API Key, and Context Window. A Base URL is also required for a `Custom` Provider.

### Remove a model

```bash
autryn config model remove <model_name>
```

Without a model name, the CLI displays a selection list:

```bash
autryn config model remove
```

If an Agent Group, Agent Profile, or Context Compaction configuration still references the model, the command blocks its removal. Rebind those references before removing the model.

### Set the default model

```bash
autryn config model set-default <model_name>
```

Without a model name, the CLI displays a selection list:

```bash
autryn config model set-default
```

The default model is used by the Entry Agent of the default Agent Group. Existing Sessions keep their Agent-level Model Overrides and Profile Bindings unless they are changed explicitly with `/model`.

## CLI usage

Start a new Session draft:

```bash
autryn
```

Resume the most recently updated available Session for the current project:

```bash
autryn --continue
```

Resume a Session by full ID, unique ID prefix, or exact name:

```bash
autryn --resume <selector>
```

Common TUI commands:

| Command              | Description                            |
| -------------------- | -------------------------------------- |
| `/session`           | Show the current Session               |
| `/sessions`          | List Sessions for the current project  |
| `/sessions --all`    | List Sessions for all projects         |
| `/resume <selector>` | Resume a selected Session              |
| `/new [name]`        | Create a new Session draft             |
| `/rename <name>`     | Rename the current Session             |
| `/model`             | Show available models                  |
| `/model <model>`     | Switch the Active Agent's Model        |
| `/model <agent-id> <model>` | Switch a selected Agent's Model |
| `/mode [execute\|dry-run]` | Show or switch the next Turn's Execution Mode |
| `/memory`            | Show Global and Project Memory         |
| `/remember <text>`   | Ask the current Agent to save long-term knowledge |
| `/clear`             | Clear the current Session transcript   |
| `/delete confirm`    | Permanently delete the current Session |
| `/help [command]`    | Show Slash Command help                |
| `/exit` or `/quit`   | Exit the TUI                           |

## Session management

Autryn uses locally persisted Sessions to retain the conversation context between the user and the root Agent. Running `autryn` directly creates a new Session draft each time. To continue an existing conversation, use `autryn --continue`, `autryn --resume <selector>`, or `/resume <selector>` in the TUI.

Sessions are stored under the current user's Home directory by default:

| System  | Default path                                       |
| ------- | -------------------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\sessions\<session-id>\`     |
| macOS   | `/Users/<username>/.autryn/sessions/<session-id>/` |
| Linux   | `/home/<username>/.autryn/sessions/<session-id>/`  |

When `AUTRYN_HOME` is set:

| System        | Path                                   |
| ------------- | -------------------------------------- |
| Windows       | `<AUTRYN_HOME>\sessions\<session-id>\` |
| macOS / Linux | `<AUTRYN_HOME>/sessions/<session-id>/` |

Each Session contains a stable ID, name, working directory, project identity, Agent Group, Active Agent, Agent-level Model Overrides, root Branch transcript, and per-Turn state and usage information. A Session does not store API Keys, SDK Clients, `AbortController` instances, live stream objects, approval callbacks, or child execution transcripts.

Session writes use revision snapshots and lease files to prevent concurrent processes from overwriting one another. `/clear` preserves the Session ID, name, working directory, Agent Group, Active Agent, and Model Overrides while clearing only the transcript. `/new` creates a new Session ID.

Input history is also stored under the current user's Home directory:

| System  | Default path                            |
| ------- | --------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\history.txt`     |
| macOS   | `/Users/<username>/.autryn/history.txt` |
| Linux   | `/home/<username>/.autryn/history.txt`  |

When `AUTRYN_HOME` is set, the Windows path is `<AUTRYN_HOME>\history.txt`, while the macOS / Linux path is `<AUTRYN_HOME>/history.txt`. This file is used only for up-arrow and down-arrow history in the terminal input. It is not sent to the model as Session context and is not deleted by `/clear`.

### Memory

Autryn separates long-term knowledge into two independent Scopes: Global Memory stores knowledge reusable across projects, while Project Memory stores knowledge for the current workspace. Their default locations are:

| System | Global Memory | Project Memory |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.autryn\memory\global\` | `%USERPROFILE%\.autryn\memory\projects\<project-id>\` |
| macOS | `/Users/<username>/.autryn/memory/global/` | `/Users/<username>/.autryn/memory/projects/<project-id>/` |
| Linux | `/home/<username>/.autryn/memory/global/` | `/home/<username>/.autryn/memory/projects/<project-id>/` |

When `AUTRYN_HOME` is set, append `memory/global/` or `memory/projects/<project-id>/` to that directory.

Before each Model call, the Runtime loads the `MEMORY.md` indexes in Global-then-Project order. An Agent uses `memory_read` to read Topic Documents and `memory_write` to explicitly create or update knowledge. Access, write-Tool availability, and Bootstrap Budgets can be configured independently for each Scope. Memory is separate from the Session transcript and is not removed by `/clear`.

Non-interactive inspection commands:

```bash
autryn memory list --scope all
autryn memory show MEMORY.md --scope global
autryn memory path --scope project
```

### Non-interactive commands

List Sessions:

```bash
autryn session list
autryn session list --all
autryn session list --json
```

Show Session metadata:

```bash
autryn session show <selector>
autryn session show <selector> --json
```

Rename a Session:

```bash
autryn session rename <selector> <name>
```

Permanently delete a Session:

```bash
autryn session delete <selector> --yes
```

Force-release a Session lock:

```bash
autryn session unlock <selector> --force
```

## Agent capabilities

### Model and Provider

The `core` module defines foundational abstractions such as Model, Message, and Tool. Providers translate between Autryn's unified message format and a specific service API.

Built-in Providers:

- `providers/openai`: OpenAI Chat Completions API and compatible endpoints.
- `providers/anthropic`: Anthropic Messages API.

### Agent Groups and Handoff

An Agent Group defines the Entry Agent, Agent Profiles, Model Bindings, Tool/Middleware Policies, and Delegation/Handoff targets. Different Agents may reference different Models. Within one Session, `/model` changes an Agent-level Override without creating a new Session.

Handoff creates a successor Agent in the same Execution Branch. The successor uses its own Prompt, Model, Tools, Middleware, and Memory Policy while continuing the root Branch's canonical transcript, Context Compaction state, and dry-run constraint. After Handoff Commit, the Session's Active Agent becomes the successor.

### dry-run

`--dry-run` or `activeExecutionMode: dry_run` applies to the entire Execution Tree. Read and control Tools may execute; Mutation Tools produce only Previews. A Preview does not write to the workspace, Memory Store, or other persistent resources.

### Agent Loop

The `runtime` module provides a general-purpose Agent Loop. It maintains message context, invokes the Model, executes Tools, merges Tool Results, and produces streaming output.

Middleware can observe or modify context before and after Agent execution, Model calls, and Tool calls. Available Hooks include:

| Hook              | When it runs                                                 |
| ----------------- | ------------------------------------------------------------ |
| `beforeAgentRun`  | After the user message is appended and before the first step |
| `afterAgentRun`   | When the Agent completes normally without another Tool call  |
| `beforeAgentStep` | At the start of each step, before the Model call             |
| `afterAgentStep`  | At the end of each step, after Tool calls finish             |
| `beforeModel`     | Before a request is sent to the Model Provider               |
| `afterModel`      | After a Model response is received                           |
| `beforeToolUse`   | Before a Tool call                                           |
| `afterToolUse`    | After a Tool call                                            |
| `beforeHandoff`   | Before the Handoff successor is created                      |
| `afterHandoff`    | After the Handoff is committed                               |

### Coding Agent

The `coding` module assembles the general-purpose Agent Loop for developer workflows and includes common coding Tools:

- Read, write, and move files, and create directories.
- Replace strings and apply patches.
- List files, run glob and full-text searches, and inspect file information.
- Execute commands.
- Load project-level `AGENTS.md` guidance.
- Apply Skills Middleware.

### Agent Skills

Autryn supports the Agent Skills format and searches for Skills in this order:

```text
<project>/.agents/skills
<AUTRYN_HOME>/skills
```

The paths above use `/` to show hierarchy; Windows uses `\`. `<project>` is the current Session's working directory. When `AUTRYN_HOME` is not set, it defaults to the current user's `.autryn` directory. If multiple Skills have the same case-insensitive name, the first one in the search order is used.

### Agent Delegation

Agent Delegation allows one Agent execution to delegate a subtask through the `delegate_task` Tool to a delegate configured in the same Agent Group. The Model can select only the delegate name and task content. It cannot directly set the child execution's Tools, model options, permissions, or approval state; the Application Factory resolves the target Agent configuration.

Default Delegation boundaries:

| Dimension  | Default behavior                                      |
| ---------- | ----------------------------------------------------- |
| Transcript | The child uses a new context containing only the task |
| Model      | Inherited from the parent execution                   |
| Tools      | Not inherited                                         |
| Skills     | Not inherited                                         |
| Middleware | Not inherited                                         |
| Delegates  | Not inherited                                         |

The Runtime enforces default limits for depth, child execution count, concurrency, timeout, and steps. Cancelling a parent execution cascades cancellation to its child executions.

## Project structure

```text
src/
├── core/          # Foundational abstractions: Model, Message, Tool
├── runtime/       # Agent Loop, execution, Delegation, Middleware
├── sessions/      # Session persistence and resumption
├── memory/        # Global / Project Memory, retrieval, persistence
├── providers/     # Provider adapters (OpenAI / Anthropic)
├── coding/        # Coding Agent and development Tools
└── terminal/      # CLI, TUI, configuration, settings
```

## Use as a library

In addition to the CLI, Autryn exposes Public APIs for TypeScript projects.

Create a Coding Agent:

```ts
import { createCodingAgent } from "autryn/coding";
import { OpenAIModelProvider } from "autryn/providers/openai";
import { Model } from "autryn/core";

const provider = new OpenAIModelProvider({
  baseURL: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

const model = new Model("gpt-4o", provider, {
  max_tokens: 16 * 1024,
});

const agent = await createCodingAgent({
  model,
  capabilities: { toolProfile: "read_only" },
  defaultDelegates: false,
});

const stream = await agent.stream({
  role: "user",
  content: [{ type: "text", text: "Inspect the current project and summarize its main modules." }],
});

for await (const message of stream) {
  for (const item of message.content) {
    if (item.type === "text") {
      console.info(item.text);
    }
  }
}
```

Create an Agent with a delegate:

```ts
import { Agent, AgentRuntime, type DelegateDefinition } from "autryn/runtime";
import { Model } from "autryn/core";

const runtime = new AgentRuntime();
declare const model: Model;

const helper: DelegateDefinition = {
  name: "helper",
  description: "Handles isolated subtasks.",
  create: ({ parentModel }) => ({
    name: "helper",
    model: parentModel,
    prompt: "Answer only the delegated task.",
  }),
};

const agent = new Agent({
  model,
  prompt: "You may call delegate_task for isolated subtasks.",
  runtime,
  delegates: [helper],
});

const execution = agent.execute({
  role: "user",
  content: [{ type: "text", text: "Ask helper to analyze the issue, then summarize the conclusion." }],
});

const result = await execution.result;
const tree = runtime.getTree(result.rootExecutionId);
```

## Development

Install dependencies:

```bash
bun install
```

Run in development mode:

```bash
bun run dev
```

Build Library artifacts (JavaScript and type declarations):

```bash
bun run build:library
```

Build binaries:

```bash
bun run build:bin
```

Build GitHub Release assets:

```bash
bun run release:github:assets
```

This command produces the Library `.tgz` package and six platform binaries. GitHub also generates Source Code ZIP and TAR.GZ archives for the corresponding tag.

Publish a GitHub Release:

Windows PowerShell:

```powershell
$env:GITHUB_TOKEN = "<token>"
bun run release:github
```

macOS / Linux:

```bash
export GITHUB_TOKEN="<token>"
bun run release:github
```

The release script requires a clean working tree, builds the JavaScript artifacts and binaries for six platform targets, creates or reuses the tag for the current version, and uploads the Release assets to the repository configured in `autryn.releaseRepository` in `package.json`. To publish to another repository, set `AUTRYN_RELEASE_REPOSITORY` to `<owner>/<repository>` before running the command.

Run the quality checks:

```bash
bun run check
```

Run only the tests:

```bash
bun test
```

## Current limitations

- Sessions store the root Agent transcript but not child execution transcripts.
- Agent Delegation does not currently provide detached children, a persistent execution store, a remote scheduler, or automatic retries.
- The TUI does not yet provide a complete child execution transcript or execution-tree panel.
- The Agent Team collaboration layer has not been implemented.

## Roadmap

- **Agent Team**: Coordinate multiple Agents to plan work, delegate tasks, and aggregate results.
- **Print Mode**: Provide terminal rendering designed for non-interactive output.
