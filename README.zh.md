> [English Version](./README.md) — [中文版本](./README.zh.md)

# Autryn

<p>
  <a href="https://bun.com"><img src="https://img.shields.io/badge/Bun-000000?logo=bun&amp;logoColor=ffffff" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&amp;logoColor=ffffff" alt="TypeScript"></a>
  <a href="https://github.com/vadimdemedes/ink"><img src="https://img.shields.io/badge/Ink-000000?logo=npm&amp;logoColor=ffffff" alt="Ink"></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-61DAFB?logo=react&amp;logoColor=000000" alt="React"></a>
</p>

Autryn 是一个本地 AI Agent Runtime，提供可复用的 Agent Loop、Provider 抽象、Coding Agent、持久化 Session、分层 Memory、Agent Delegation、Handoff 和终端交互界面。

`Autryn` 取意于 Autonomy 与 Runtime，表达其核心定位：为自主 Agent 提供可靠、可扩展的 Runtime。

Autryn 可通过 npm 直接从 GitHub 安装 CLI，也支持从源码构建，供开发和贡献使用。

## 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [安装](#安装)
- [模型配置](#模型配置)
- [命令行使用](#命令行使用)
- [Session 管理](#session-管理)
- [Agent 能力](#agent-能力)
- [项目结构](#项目结构)
- [作为库使用](#作为库使用)
- [开发](#开发)
- [当前限制](#当前限制)
- [路线图](#路线图)

## 功能概览

- **统一模型抽象**：通过 `Model` 和 Provider 接口接入 OpenAI、Anthropic 及其兼容服务。
- **Coding Agent**：内置文件读写、搜索、补丁应用和命令执行等开发 Tool。
- **持久化 Session**：支持创建、恢复、重命名、清空、删除，以及跨项目查看 Session。
- **Context 压缩**：基于显式 Model Context Window，在长对话中构建有界 Model 输入并保留完整 Session。
- **模型切换**：在同一 Session 内按 Agent 设置 Model；切换结果从下一次请求开始生效，不会中断正在运行的任务。
- **Global 与 Project Memory**：以两层 Scope 保存可跨 Session 复用的长期知识，支持按权限读取、显式写入和 dry-run Preview。
- **Skill 加载**：支持从 `AUTRYN_HOME` 和项目目录发现并加载 Agent Skills。
- **Agent Delegation**：通过受控的 Delegation 机制，将子任务交给同一 Runtime 中注册的其他 Agent 执行。
- **Agent Handoff**：在同一 Execution Branch 中将控制权交给配置的 successor Agent，并保持会话连续性。
- **dry-run**：沿 Execution Tree 生成 Tool 和 Memory 变更 Preview，不提交 Mutation。
- **TUI 交互**：使用 Ink/React 构建终端交互界面。

## 快速开始

使用 npm 从 GitHub 全局安装：

```bash
npm install -g github:zijie1024/autryn#v0.1.0
```

进入希望 Autryn 操作的项目目录，然后启动 CLI。

Windows PowerShell：

```powershell
Set-Location C:\path\to\your\project
autryn
```

macOS / Linux：

```bash
cd /path/to/your/project
autryn
```

这里的项目目录是 Autryn 的工作区，而不是 Autryn 的源码目录。Autryn 会以当前目录作为文件操作、命令执行、项目级 Skill 加载和 Session 归属的基础。

首次启动时，CLI 会引导你添加模型配置。

## 安装

### 使用 npm 从 GitHub 安装

以下命令使用 npm 从 GitHub 仓库安装 Autryn，而不是从 npm registry 获取包。安装包提供全局 `autryn` 命令；首次运行时，启动器会根据当前操作系统和 CPU 架构下载相同版本的 GitHub Release 二进制文件。

安装前请确保已安装 Node.js 20 或更高版本、npm 和 Git。

安装命令：

```bash
npm install -g github:zijie1024/autryn#v0.1.0
```

二进制文件默认缓存在当前用户的 Home 目录中，常见路径如下：

| 系统    | 缓存目录                                   |
| ------- | ------------------------------------------ |
| Windows | `%USERPROFILE%\.autryn\bin\<version>\`     |
| macOS   | `/Users/<username>/.autryn/bin/<version>/` |
| Linux   | `/home/<username>/.autryn/bin/<version>/`  |

该缓存目录固定基于当前用户的 Home 目录，不受 `AUTRYN_HOME` 影响。

安装完成后，在任意目标项目目录中运行 `autryn`。当前工作目录将作为 Autryn 的工作区。

支持的 Release 资产名称：

| 系统    | 架构  | Release 资产             |
| ------- | ----- | ------------------------ |
| Windows | x64   | `autryn-win32-x64.exe`   |
| Windows | arm64 | `autryn-win32-arm64.exe` |
| macOS   | x64   | `autryn-darwin-x64`      |
| macOS   | arm64 | `autryn-darwin-arm64`    |
| Linux   | x64   | `autryn-linux-x64`       |
| Linux   | arm64 | `autryn-linux-arm64`     |

### 从 GitHub Release 安装 Library

GitHub Release 同时提供可安装的 `autryn-<version>.tgz`。例如：

```bash
npm install https://github.com/zijie1024/autryn/releases/download/v0.1.0/autryn-0.1.0.tgz
```

Library 使用 Bun API，运行 TypeScript 或 JavaScript 集成代码时需要 Bun Runtime；CLI 的独立二进制不需要 Bun。

默认下载地址由安装包 `package.json` 中的 `autryn.releaseRepository` 决定。如需使用其他仓库或镜像，可通过以下环境变量覆盖：

- `AUTRYN_RELEASE_REPOSITORY`：GitHub 仓库，格式为 `<owner>/<repository>`。
- `AUTRYN_RELEASE_BASE_URL`：Release 资产所在的完整基础 URL，例如 `https://example.com/autryn/v0.1.0`。设置后优先于仓库配置。

### 从源码构建（开发者）

源码构建是面向开发和贡献者的替代安装方式，不是全局安装后的必要步骤。请先进入 Autryn 源码目录，再安装依赖并构建当前平台的二进制文件：

```bash
bun install
bun run build:bin
```

构建完成后，再进入目标项目目录并运行生成的二进制文件。

macOS / Linux：

```bash
cd /path/to/your/project
/path/to/autryn/dist/bin/autryn
```

Windows PowerShell：

```powershell
Set-Location C:\path\to\your\project
& C:\path\to\autryn\dist\bin\autryn.exe
```

使用 `--help` 可查看命令帮助。首次启动时，CLI 会引导你添加模型配置。

## 模型配置

Autryn 默认在当前用户的 Home 目录下保存配置，常见路径如下：

| 系统    | 默认路径                                |
| ------- | --------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\config.yaml`     |
| macOS   | `/Users/<username>/.autryn/config.yaml` |
| Linux   | `/home/<username>/.autryn/config.yaml`  |

设置 `AUTRYN_HOME` 后，配置文件位于该目录下的 `config.yaml`：

| 系统          | 路径                        |
| ------------- | --------------------------- |
| Windows       | `<AUTRYN_HOME>\config.yaml` |
| macOS / Linux | `<AUTRYN_HOME>/config.yaml` |

在当前 Shell 中临时设置该变量：

Windows PowerShell：

```powershell
$env:AUTRYN_HOME = "D:\AutrynData"
```

macOS / Linux：

```bash
export AUTRYN_HOME="$HOME/.autryn-data"
```

### Provider 类型

模型配置支持四类入口：

| 配置入口                        | Provider 类型 | Base URL                         |
| ------------------------------- | ------------- | -------------------------------- |
| `Anthropic (Official)`          | `anthropic`   | 使用 Anthropic 官方端点          |
| `OpenAI (Official)`             | `openai`      | 使用 `https://api.openai.com/v1` |
| `Anthropic-compatible (Custom)` | `anthropic`   | 使用自定义 Anthropic 兼容端点    |
| `OpenAI-compatible (Custom)`    | `openai`      | 使用自定义 OpenAI 兼容端点       |

`Official` 使用服务商官方端点；`Custom` 允许连接遵循相应 API 格式的兼容服务。自定义 Base URL 必须是完整的 `http` 或 `https` URL。API Key 在配置列表和相关界面中会以掩码形式显示。

### 查看模型

```bash
autryn config model list
```

### 添加模型

```bash
autryn config model add
```

添加流程会要求选择 Provider 类型，并输入模型名称、API Key 与 Context Window；使用 `Custom` 入口时还需要提供 Base URL。

### 删除模型

```bash
autryn config model remove <model_name>
```

不传模型名时，CLI 会展示可选列表：

```bash
autryn config model remove
```

如果模型仍被 Agent Group、Agent Profile 或 Context Compaction 配置引用，删除命令会阻止操作。请先修改相关配置，再删除该模型。

### 设置默认模型

```bash
autryn config model set-default <model_name>
```

不传模型名时，CLI 会展示可选列表：

```bash
autryn config model set-default
```

默认模型用于 Default Agent Group 的 Entry Agent。已有 Session 会继续使用各 Agent 保存的 Model Override 和 Profile Binding，除非通过 `/model` 显式切换。

## 命令行使用

启动新的 Session 草稿：

```bash
autryn
```

恢复当前项目最近更新且可用的已保存 Session：

```bash
autryn --continue
```

按完整 ID、唯一 ID 前缀或精确名称恢复 Session：

```bash
autryn --resume <selector>
```

常用 TUI 命令：

| 命令                 | 说明                        |
| -------------------- | --------------------------- |
| `/session`           | 查看当前 Session 信息       |
| `/sessions`          | 列出当前项目的 Session      |
| `/sessions --all`    | 列出所有项目的 Session      |
| `/resume <selector>` | 恢复指定 Session            |
| `/new [name]`        | 创建新的 Session 草稿       |
| `/rename <name>`     | 重命名当前 Session          |
| `/model`             | 查看可用模型                |
| `/model <model>`     | 切换当前 Active Agent 的 Model |
| `/model <agent-id> <model>` | 切换指定 Agent 的 Model |
| `/mode [execute\|dry-run]` | 查看或切换下一 Turn 的 Execution Mode |
| `/memory`            | 查看 Global 与 Project Memory |
| `/remember <text>`   | 请求当前 Agent 保存长期知识 |
| `/clear`             | 清空当前 Session 的对话记录 |
| `/delete confirm`    | 永久删除当前 Session        |
| `/help [command]`    | 查看 Slash Command 帮助     |
| `/exit` 或 `/quit`   | 退出 TUI                    |

## Session 管理

Autryn 使用本地持久化 Session 保存用户与 root Agent 的对话上下文。直接运行 `autryn` 每次都会创建新的 Session 草稿；如需继续已有对话，请使用 `autryn --continue`、`autryn --resume <selector>` 或 TUI 中的 `/resume <selector>`。

Session 默认保存在当前用户的 Home 目录下，常见路径如下：

| 系统    | 默认路径                                           |
| ------- | -------------------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\sessions\<session-id>\`     |
| macOS   | `/Users/<username>/.autryn/sessions/<session-id>/` |
| Linux   | `/home/<username>/.autryn/sessions/<session-id>/`  |

设置 `AUTRYN_HOME` 后：

| 系统          | 路径                                   |
| ------------- | -------------------------------------- |
| Windows       | `<AUTRYN_HOME>\sessions\<session-id>\` |
| macOS / Linux | `<AUTRYN_HOME>/sessions/<session-id>/` |

每个 Session 包含稳定 ID、名称、工作目录、项目标识、Agent Group、Active Agent、Agent 级 Model Override、root Branch 对话记录，以及每次 Turn 的状态与用量信息。Session 不保存 API Key、SDK Client、`AbortController`、实时流对象、审批回调或 child execution 的对话记录。

Session 写入使用 revision snapshot 和 lease 文件，避免多个进程同时写入造成覆盖。`/clear` 会保留 Session ID、名称、工作目录、Agent Group、Active Agent 和 Model Override，只清空对话记录；`/new` 会创建新的 Session ID。

输入历史也保存在当前用户的 Home 目录下，常见路径如下：

| 系统    | 默认路径                                |
| ------- | --------------------------------------- |
| Windows | `%USERPROFILE%\.autryn\history.txt`     |
| macOS   | `/Users/<username>/.autryn/history.txt` |
| Linux   | `/home/<username>/.autryn/history.txt`  |

设置 `AUTRYN_HOME` 后，Windows 路径为 `<AUTRYN_HOME>\history.txt`，macOS / Linux 路径为 `<AUTRYN_HOME>/history.txt`。该文件仅用于终端输入框的上下键历史，不会作为 Session 上下文发送给模型，也不会被 `/clear` 删除。

### Memory

Autryn 将长期知识分为两个独立 Scope：Global Memory 保存可跨项目复用的知识，Project Memory 保存当前工作区的知识。两层 Memory 分别存储在：

| 系统 | Global Memory | Project Memory |
| --- | --- | --- |
| Windows | `%USERPROFILE%\.autryn\memory\global\` | `%USERPROFILE%\.autryn\memory\projects\<project-id>\` |
| macOS | `/Users/<username>/.autryn/memory/global/` | `/Users/<username>/.autryn/memory/projects/<project-id>/` |
| Linux | `/home/<username>/.autryn/memory/global/` | `/home/<username>/.autryn/memory/projects/<project-id>/` |

设置 `AUTRYN_HOME` 后，在该目录下追加 `memory/global/` 或 `memory/projects/<project-id>/`。

每次 Model 调用前，Runtime 按 Global、Project 的顺序加载 `MEMORY.md` 索引。Agent 通过 `memory_read` 读取 Topic Document，通过 `memory_write` 显式创建或更新知识；Global 与 Project 的访问级别、写入 Tool 是否可用以及 Bootstrap Budget 可以分别配置。Memory 不属于 Session Transcript，也不会被 `/clear` 删除。

非交互查看命令：

```bash
autryn memory list --scope all
autryn memory show MEMORY.md --scope global
autryn memory path --scope project
```

### 非交互命令

列出 Session：

```bash
autryn session list
autryn session list --all
autryn session list --json
```

查看 Session 元数据：

```bash
autryn session show <selector>
autryn session show <selector> --json
```

重命名 Session：

```bash
autryn session rename <selector> <name>
```

永久删除 Session：

```bash
autryn session delete <selector> --yes
```

强制释放 Session 锁：

```bash
autryn session unlock <selector> --force
```

## Agent 能力

### Model 与 Provider

`core` 模块提供 Model、Message 和 Tool 等基础抽象。Provider 负责在 Autryn 的统一消息格式与具体服务 API 之间进行转换。

当前内置 Provider：

- `providers/openai`：OpenAI Chat Completions API 及兼容接口。
- `providers/anthropic`：Anthropic Messages API。

### Agent Group 与 Handoff

配置文件中的 Agent Group 定义 Entry Agent、Agent Profile、Model Binding、Tool/Middleware Policy 以及 Delegation/Handoff 目标。不同 Agent 可以引用不同 Model；同一 Session 内的 `/model` 修改指定 Agent 的 Override，不会创建新 Session。

Handoff 在同一 Execution Branch 中创建 successor Agent。successor 使用自己的 Prompt、Model、Tool、Middleware 和 Memory Policy，同时继续使用同一 root Branch 的 canonical transcript、Context Compaction 状态和 dry-run 约束。Handoff Commit 后，Session 的 Active Agent 更新为 successor。

### dry-run

`--dry-run` 或 `activeExecutionMode: dry_run` 会沿整个 Execution Tree 生效。读取和控制类 Tool 可以执行，Mutation Tool 只生成 Preview；Preview 不写入工作区、Memory Store 或其他持久化资源。

### Agent Loop

`runtime` 模块提供通用 Agent Loop，负责维护消息上下文、调用 Model、执行 Tool、合并 Tool Result 并生成流式输出。

Middleware 可以在 Agent 执行、Model 调用和 Tool 调用的前后观察或调整上下文。可用 Hook 包括：

| Hook              | 触发时机                       |
| ----------------- | ------------------------------ |
| `beforeAgentRun`  | 用户消息追加后、第一步执行前   |
| `afterAgentRun`   | Agent 正常完成且不再调用 Tool 时 |
| `beforeAgentStep` | 每一步开始时、调用模型之前     |
| `afterAgentStep`  | 每一步结束时、工具调用完成之后 |
| `beforeModel`     | 请求发送给 Model Provider 之前 |
| `afterModel`      | 收到 Model 响应之后            |
| `beforeToolUse`   | Tool 调用之前                  |
| `afterToolUse`    | Tool 调用之后                  |
| `beforeHandoff`   | Handoff successor 创建之前     |
| `afterHandoff`    | Handoff 提交之后               |

### Coding Agent

`coding` 模块基于通用 Agent Loop 组装开发者工作流，内置常用编码 Tool，包括：

- 文件读取、写入、移动和目录创建。
- 字符串替换和补丁应用。
- 文件列表、glob 搜索、全文搜索和文件信息读取。
- 命令执行。
- 项目级 `AGENTS.md` 指导加载。
- Skills Middleware。

### Agent Skills

Autryn 支持 Agent Skills 格式，并按以下顺序搜索 Skill：

```text
<project>/.agents/skills
<AUTRYN_HOME>/skills
```

以上使用 `/` 表示路径层级；Windows 上对应使用 `\`。`<project>` 表示当前 Session 的工作目录。未设置 `AUTRYN_HOME` 时，它默认为当前用户的 `.autryn` 目录。同名 Skill（名称不区分大小写）按上述搜索顺序采用第一个。

### Agent Delegation

Agent Delegation 允许一次 Agent execution 通过 `delegate_task` Tool，将子任务交给同一 Agent Group 中配置的 delegate。Model 只能选择 delegate 名称和任务内容，不能直接指定 child execution 的 Tool、模型参数、权限或审批状态；目标 Agent 的配置由 Application Factory 决定。

默认委派边界：

| 维度       | 默认行为                         |
| ---------- | -------------------------------- |
| Transcript | 子执行使用新的上下文，仅包含任务 |
| Model      | 继承父执行模型                   |
| Tools      | 不继承                           |
| Skills     | 不继承                           |
| Middleware | 不继承                           |
| Delegates  | 不继承                           |

Runtime 默认限制包括最大深度、child execution 数量、并发数量、超时和 step 上限。parent execution 取消时会级联取消 child execution。

## 项目结构

```text
src/
├── core/          # Model、Message、Tool 等基础抽象
├── runtime/       # Agent Loop、execution、Delegation、Middleware
├── sessions/      # Session 持久化与恢复
├── memory/        # Global / Project Memory、检索与持久化
├── providers/     # Provider 适配器（openai / anthropic）
├── coding/        # Coding Agent 与开发 Tool
└── terminal/      # CLI、TUI、配置、设置
```

## 作为库使用

除 CLI 外，也可以在 TypeScript 项目中导入 Autryn 的公开 API。

创建一个 Coding Agent：

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
  content: [{ type: "text", text: "检查当前项目并总结主要模块。" }],
});

for await (const message of stream) {
  for (const item of message.content) {
    if (item.type === "text") {
      console.info(item.text);
    }
  }
}
```

创建带 delegate 的 Agent：

```ts
import { Agent, AgentRuntime, type DelegateDefinition } from "autryn/runtime";
import { Model } from "autryn/core";

const runtime = new AgentRuntime();
declare const model: Model;

const helper: DelegateDefinition = {
  name: "helper",
  description: "处理隔离子任务。",
  create: ({ parentModel }) => ({
    name: "helper",
    model: parentModel,
    prompt: "只回答被委派的任务。",
  }),
};

const agent = new Agent({
  model,
  prompt: "你可以为隔离子任务调用 delegate_task。",
  runtime,
  delegates: [helper],
});

const execution = agent.execute({
  role: "user",
  content: [{ type: "text", text: "调用 helper 分析问题，然后总结结论。" }],
});

const result = await execution.result;
const tree = runtime.getTree(result.rootExecutionId);
```

## 开发

安装依赖：

```bash
bun install
```

以开发模式运行：

```bash
bun run dev
```

构建 Library 产物（JavaScript 与类型声明）：

```bash
bun run build:library
```

构建二进制文件：

```bash
bun run build:bin
```

构建 GitHub Release 资产：

```bash
bun run release:github:assets
```

该命令生成 Library `.tgz` 和六个平台二进制。GitHub Release 页面会自动提供对应 Tag 的源码 ZIP 与 TAR.GZ。

发布 GitHub Release：

Windows PowerShell：

```powershell
$env:GITHUB_TOKEN = "<token>"
bun run release:github
```

macOS / Linux：

```bash
export GITHUB_TOKEN="<token>"
bun run release:github
```

发布脚本会检查工作区是否干净，构建 JavaScript 产物和六个平台二进制，创建或复用当前版本号对应的 tag，并把 Release 资产上传到 `package.json` 中配置的 `autryn.releaseRepository`。如果发布到其他仓库，可在运行命令前将 `AUTRYN_RELEASE_REPOSITORY` 环境变量设置为 `<owner>/<repository>`。

运行检查：

```bash
bun run check
```

仅运行测试：

```bash
bun test
```

## 当前限制

- Session 保存 root Agent 的对话记录，不保存 child execution 的对话记录。
- Agent Delegation 暂不提供 detached child、持久化 execution store、远程 scheduler 或自动重试。
- TUI 暂未提供完整的 child execution 对话记录或 execution tree 面板。
- Agent Team 协作层尚未实现。

## 路线图

- **Agent Team**：支持多个 Agent 协同规划、委派和汇总结果。
- **Print Mode**：提供更适合非交互输出的终端渲染模式。
