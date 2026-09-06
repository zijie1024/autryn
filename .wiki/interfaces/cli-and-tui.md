---
title: CLI 与 TUI
summary: 说明 Autryn 的启动 Mode、Session、Memory、非交互 Command、TUI Slash Command 和工作目录语义。
sources:
  - index.ts
  - src/terminal/index.tsx
  - src/terminal/commands/
  - src/terminal/tui/command-registry.ts
  - src/terminal/tui/app.tsx
  - src/terminal/session/
  - tests/terminal/
related:
  - architecture/terminal.md
  - workflows/session-lifecycle.md
  - workflows/model-selection.md
  - workflows/dry-run.md
  - architecture/memory.md
  - interfaces/configuration-and-storage.md
---

# CLI 与 TUI

`autryn` 同时提供交互式 TUI 和基于 Commander 的非交互命令。根入口根据第一个参数选择路径：无命令或只有 Session 恢复选项时启动 TUI；Help、Version 和具体子命令直接交给 Commander。

## TUI 启动模式

- `autryn` 创建当前工作目录下的新 Session 草稿。
- `autryn --dry-run` 创建 Mode 为 dry-run 的新 Session 草稿。
- `autryn --continue` 恢复当前项目最近更新且健康为 ready 的 Session。
- `autryn --resume <selector>` 按完整 ID、唯一 ID 前缀或精确名称跨项目恢复。
- `--continue` 与 `--resume` 互斥，未知根选项和缺失 selector 显式失败。

启动 TUI 前执行运行完整性检查，并加载或初始化模型配置。恢复成功后，Session Record 中的 cwd 成为工作区；新草稿使用进程当前目录。Skill 搜索、Code Tool 的 Shell cwd、Project Guidance、Global/Project Memory 和项目 Settings 都围绕该工作区建立。

## 非交互 Command

Model 配置命令位于 `autryn config model`，提供 add、list、remove 和 set-default；Agent Group 命令位于 `autryn config agent-group`，提供 list、show 和 validate。Session 命令位于 `autryn session`，提供 list、show、rename、delete 和 unlock。Memory 命令位于 `autryn memory`，提供 list、show 和 path。列表和详情支持稳定 JSON 输出；Session Show 只输出元数据，不打印 Transcript，Memory Show 输出用户明确选择的 Document。Delete 和强制 Unlock 需要明确确认选项。

完整参数与用法由 CLI `--help` 和 README 承担。Wiki 只记录能力分组、共享语义和实现边界。

## TUI Slash Command

内置 Registry 提供：

- `/session` 与 `/sessions` 查看当前或已保存 Session。
- `/resume`、`/new`、`/rename`、`/clear` 和 `/delete confirm` 管理 Session。
- `/model` 查看可用 Model，或切换当前 Active Agent 的 Model。
- `/model <agent-id> <model>` 切换指定 Agent 的 Model Override。
- `/mode` 查看或切换下一 Turn 的 execute 或 dry-run Mode。
- `/memory` 按 Global、Project 分组查看 Memory Scope、Document 和本地路径。
- `/remember <text>` 把保存请求交给当前 Agent，由 Memory Tool 按 Policy 处理。
- `/help` 查看内置命令和 Skill Command。
- `/exit` 与 `/quit` 退出 TUI。

发现的 Skill 也注册为 Slash Command。内置命令优先，同名条目去重；用户选择 Skill 时，该名称只作为当前 prompt submission 的显式 Skill 请求。

## 共享领域服务

TUI 的 Session 操作统一经过 SessionController，Agent 通过 AgentRegistry 重建，Model 统一经过 ModelResolver，Memory 通过 Adapter 接入，Settings 统一经过 Loader/Writer。非交互 Command 复用相应领域 Service。UI 组件不直接实现 Provider 转换、Session 文件协议、Memory Store 或 Runtime Scheduler。

消息渲染同时存在 ANSI 文本和 Ink 组件路径，两者共享 Tool Summary。TUI 监听 Agent Message 与 progress，展示 active Agent、Mode、审批和问题队列；Execution Result、Session 状态与结构化错误仍由领域层定义。

## 工作目录与状态

当前工作目录是用户希望 Agent 操作的项目。它决定新 Session 的 project key、Project Memory Scope、项目 Skill 与 `AGENTS.md`、项目 Settings 和 Code Tool 命令上下文；Global Memory 则由用户级配置决定。跨项目恢复后，记录中的工作目录继续生效；目录、Agent Group、Model 或 Active Agent 缺失时可以查看 Session，但不能开始 Turn。

Session 状态语义见[Session 生命周期](../workflows/session-lifecycle.md)，文件位置见[配置与存储](configuration-and-storage.md)。
