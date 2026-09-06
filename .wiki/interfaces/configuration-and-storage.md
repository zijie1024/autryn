---
title: 配置与存储
summary: 说明 AUTRYN_HOME、模型配置、Settings、Session、Memory、输入历史和跨平台路径及敏感数据边界。
sources:
  - src/sessions/home.ts
  - src/sessions/session-paths.ts
  - src/sessions/file-session-store.ts
  - src/memory/file/
  - src/terminal/config/
  - src/terminal/bootstrap/first-run-wizard.tsx
  - src/terminal/settings/
  - src/terminal/tui/hooks/use-input-history.ts
  - bin/autryn.mjs
related:
  - architecture/sessions.md
  - architecture/terminal.md
  - workflows/session-lifecycle.md
  - workflows/model-selection.md
  - workflows/context-compaction.md
  - architecture/memory.md
  - engineering/security-and-permissions.md
---

# 配置与存储

Autryn 将模型配置、用户 Settings、Session、Memory 和输入历史集中在 Autryn Home 下，并把项目级 Settings 放在目标工作目录。路径统一通过 Node/Bun 的跨平台 API 计算，不依赖固定盘符或 `/` 分隔符。

## Autryn Home

未设置 `AUTRYN_HOME` 时，终端启动流程将其初始化为当前用户 Home 下的 `.autryn`。常见位置为：

| 系统    | 默认位置                    |
| ------- | --------------------------- |
| Windows | `%USERPROFILE%\.autryn`     |
| macOS   | `/Users/<username>/.autryn` |
| Linux   | `/home/<username>/.autryn`  |

显式设置 `AUTRYN_HOME` 后，配置、用户 Settings、Session、Memory、输入历史和该目录下的 Skill 使用新根目录。调用路径 helper 前，终端负责确保环境变量和目录已经初始化。

npm 启动器的预编译二进制缓存固定使用用户 Home 下的 `.autryn/bin/<version>`，不受 `AUTRYN_HOME` 影响。它属于启动器分发缓存，不是 Runtime 配置或 Session 存储。

## 模型配置

`<AUTRYN_HOME>/config.yaml` 保存 Model Catalog、Agent Groups 和默认 Execution Mode。Model Entry 包括稳定 UUID、显示名称、实际模型名称、Base URL、API Key、`openai` 或 `anthropic` 类型，以及用于 Context 压缩的 Context Window。Agent Group 包括 Entry Agent、Agent Profiles、Model Binding、能力 Policy 和 Delegation/Handoff Edge。Schema 要求至少一个 Model、至少一个 Group、名称与 ID 唯一且所有引用有效。写入先生成临时文件再重命名，读取错误只报告字段路径，不回显值。

四类用户入口映射为两类 Provider 协议。Official 使用固定 Base URL；Custom 要求绝对 HTTP(S) URL。API Key 仅在配置和 Provider Client 构造中使用，列表与 UI 使用掩码。

新建模型配置会写入 `contextWindowTokens` 并默认启用自动 Context 压缩。`contextCompaction.summaryModelConfigId` 可以指向同一配置文件中的专用摘要模型；引用不存在的 Model ID 会被配置 Schema 拒绝。完整压缩语义见[Context 压缩](../workflows/context-compaction.md)。

配置同时保存 `defaultExecutionMode`，取值为 `execute` 或 `dry_run`。首次启动向导在模型配置完成后要求用户选择默认模式；该值只决定新建 Session 的初始模式，已有 Session 使用各自持久化的 active Execution Mode。

## Settings

Settings 按以下顺序加载：

1. `<AUTRYN_HOME>/settings.json`
2. `<project>/.autryn/settings.json`
3. `<project>/.autryn/settings.local.json`

后层覆盖普通顶层字段，`permissions.allow` 在各层之间取并集。Memory 的 `enabled` 与 `autoWrite` 默认启用，任意层设置为 `false` 后保持收紧状态。TUI 中“项目始终允许”写入项目本地文件，不修改共享项目 Settings。无效或不可解析的 Settings 层被忽略并给出不含内容的警告。

Memory Settings 可以分别设置 `memory.global.enabled`、`memory.global.autoWrite`、`memory.project.enabled` 和 `memory.project.autoWrite`。Global 与 Project 独立计算收紧结果；Agent Profile 仍可进一步降低访问级别，但不能通过 Settings 重新提升权限。

## Session

Session 位于 `<AUTRYN_HOME>/sessions/<session-id>/`。每个目录包含 revision JSON 快照以及写入期间的 lease；Clear 可能短暂使用 intent 文件。Session 路径 helper 验证 canonical UUID 和根目录边界。文件权限、原子重命名、revision 与 lease 共同保护本地持久化。

Session Record 保存工作区、Agent Group、Active Agent、Agent 级 Model Overrides、Execution Mode、root Branch Transcript、Turn 和 Compaction 派生状态，不保存 API Key、Client、AbortController、流、审批回调或 Child Transcript。详细生命周期见[Session 生命周期](../workflows/session-lifecycle.md)。

## Memory

Global Memory 位于 `<AUTRYN_HOME>/memory/global/`，Project Memory 位于 `<AUTRYN_HOME>/memory/projects/<project-id>/`。每个 Scope 的 `scope.json` 绑定自身身份，`MEMORY.md` 保存常驻索引，其余 Markdown 文件保存 Topic Document。读取不会物化空 Scope，写入通过 Scope Lock、digest、临时文件和 rename 完成并发保护。完整领域语义见[Memory](../architecture/memory.md)。

## 输入历史

TUI 输入历史位于 `<AUTRYN_HOME>/history.txt`，只保留有限数量的最近非空、非连续重复输入。该文件服务于输入框上下键浏览，不是 Session transcript，不会发送给 Model，也不随 `/clear` 删除。

## 敏感数据边界

API Key、Token、用户输入、对话和本地绝对路径均按敏感数据处理。配置错误不显示值，模型列表移除 API Key，Session 错误写入前清理常见凭据形式。配置目录和项目本地 Settings 仍由用户负责设置适当的操作系统访问权限与版本控制忽略规则。

安全与 Tool 权限见[安全与权限](../engineering/security-and-permissions.md)。
