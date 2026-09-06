---
title: terminal 模块
summary: 说明 terminal 如何组合 CLI、TUI、Model、Agent Registry、Memory、Settings 与 SessionController。
sources:
  - src/terminal/
  - tests/terminal/
  - index.ts
related:
  - architecture/system.md
  - architecture/coding.md
  - interfaces/cli-and-tui.md
  - interfaces/configuration-and-storage.md
  - workflows/session-lifecycle.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - architecture/memory.md
---

# terminal 模块

`terminal` 是 Autryn 的应用组合层。它处理首次运行、Model Catalog 与 Agent Group 配置、非交互 Command、Session、Agent 与 Model 解析、分层 Memory Adapter 创建、Settings 合并，以及基于 Ink/React 的 TUI 输入和渲染。

## 子领域

- `bootstrap/` 检查运行完整性，并在首次启动时引导创建 Model Entry 和默认 Agent Group。
- `commands/` 注册 Model、Agent Group、Session 和 Memory 的 Commander 子命令。
- `config/` 定义 Model Catalog 与 Agent Group Schema、Home 路径下的 YAML 读写和敏感错误格式化。
- `session/` 通过 ModelResolver、AgentRegistry、SessionController、Memory Runtime 和统一 Agent Factory 连接 Provider、Session、Memory 与 Agent。
- `settings/` 合并用户、项目和项目本地设置，并持久化项目 Tool Allow List。
- `tui/` 处理 Slash Command、输入历史、Execution Mode、Agent Loop Hook、审批、Memory、消息、Tool、Todo 和 Token Usage 展示。

## 启动与组合

根入口加载 `src/terminal`。CLI 根据首个参数决定运行 Commander Command 还是 TUI。TUI 启动时完成完整性检查、配置读取和 Session 选择：无恢复参数时创建草稿，`--continue` 选择当前项目最近可用 Session，`--resume` 使用跨项目 Selector。

SessionController 在每个 Turn 开始时重新加载配置，冻结 Agent Group、Agent Model 与能力策略，并捕获当前 Execution Mode、Memory Policy 和 Approval State。AgentRegistry 据此创建 `activeAgentId` 对应的 Agent；Runtime Event 中完成的消息、Handoff 与实际 Model Call 被增量写入 Session。统一 Agent Factory 按 Profile 注入 Skill、分层 Memory、Settings-backed Approval Persistence、项目规则和 TUI 的审批与问题交互能力。

## TUI 边界

TUI 以 Hook 和组件呈现 Session、active Agent、Model、Execution Mode、Message、进度、Tool Use、审批与 Todo。内置 Slash Command 通过统一 Registry 提供，Skill 也可以作为可选择命令进入 prompt submission。ANSI 文本和 Ink 组件使用共享 Tool Summary 语义，保持同一 Tool 的标题和详情一致。

SessionController 是交互状态与领域操作之间的主要边界：它阻止冲突的 Session 操作，控制 active Turn，持久化消息、Handoff 与 dry-run 结果，并把错误保留为可供 CLI/TUI 处理的领域状态。组件无需直接协调 lease 或 revision。

组合逻辑因此可以脱离具体组件验证。

## 模块边界

- `terminal` 可以依赖全部领域模块，但只负责装配和交互。
- Provider 转换、Session Store、Runtime 调度和 Coding Tool 实现保留在其所属模块。
- CLI 与 TUI 暴露相同能力时复用 SessionController、ModelResolver 和 Settings 服务。
- 当前工作目录定义新 Session 的 workspace；恢复 Session 后使用记录中的工作目录。
- 输入历史仅服务于输入框回显，不进入 Agent transcript，也不随 Session Clear 删除。

用户可见入口见[CLI 与 TUI](../interfaces/cli-and-tui.md)，路径与配置见[配置与存储](../interfaces/configuration-and-storage.md)。
