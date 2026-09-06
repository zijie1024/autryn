---
title: 系统架构
summary: 说明 Autryn 七个模块的整体关系、允许的依赖方向以及 CLI 与 Library 的组合路径。
sources:
  - src/core/
  - src/runtime/
  - src/sessions/
  - src/memory/
  - src/providers/
  - src/coding/
  - src/terminal/
  - package.json
related:
  - overview/capability-map.md
  - architecture/core.md
  - architecture/runtime.md
  - interfaces/public-api.md
---

# 系统架构

Autryn 按职责划分为 `core`、`runtime`、`sessions`、`memory`、`providers`、`coding` 和 `terminal` 七个模块。低层模块提供稳定抽象和通用机制，高层模块进行领域组合；具体 Provider、Code Tool 和终端 UI 不反向进入基础层。

## 模块关系

```text
terminal ──→ coding ──→ memory ──→ runtime ──→ core
    │            └───────────────→ runtime / core
    ├────────→ memory ───────────→ runtime / core
    ├────────→ sessions ─────────→ runtime / core
    ├────────→ providers ────────→ core
    └────────────────────────────→ runtime / core
```

- `core` 定义 Model、Message 和 Tool，不依赖其他 Autryn 模块。
- `runtime` 只依赖 `core`，拥有 Agent Loop、Execution、Middleware、Delegation、Handoff、dry-run、Skill 接入和资源控制。
- `memory` 依赖 `core` 与 `runtime` 的公开契约，提供 Global/Project Memory 领域模型、Adapter、Policy、Store、Retriever 及 Agent 接入。
- `providers` 只适配 `core` 契约，分别封装 OpenAI 与 Anthropic SDK。
- `coding` 依赖 `core`、`runtime` 与 `memory`，组合 Code Agent、开发 Tool、Project Guidance、Tool Approval、Global/Project Memory 和默认 delegate。
- `sessions` 使用 `core` 的消息类型和 `runtime` 的 Execution Result，负责可序列化的 Session 领域与 Store。
- `terminal` 可以依赖全部模块，是配置、Session、Provider、Coding Agent、CLI 与 TUI 的组合边界。

## 基础层与组合层

`core` 与 `runtime` 构成可复用 Agent 基础。它们不感知工作目录、用户配置、具体模型服务、文件编辑 Tool、Memory 存储或 React 组件。`sessions`、`memory` 与 `providers` 是可独立使用的领域和适配器；它们通过公开契约与基础层协作。

`coding` 将 Runtime 具体化为开发任务 Agent，但不拥有终端状态。`terminal` 解析配置、Agent Group、active Agent、各 Agent 的 Model 覆盖和 Memory Settings，在每个 Turn 冻结本次执行配置并完成应用装配，再把 Runtime Event 转换为终端交互。可复用领域逻辑位于其所属模块，TUI 只处理展示和输入。

## CLI 使用路径

```text
autryn
  → terminal bootstrap / config
  → SessionController + AgentRegistry + ModelResolver
  → Agent Group + Provider-backed Models
  → Agent + layered Memory Adapter
  → AgentRuntime
  → TUI events and Session persistence
```

直接启动会创建 Session 草稿；恢复参数会先选择并加载持久 Session。每次 Turn 开始时冻结当前 Agent Group、active Agent、有效 Model、Capabilities 与 Execution Mode，再使用 root transcript 创建 Agent。Tool、Delegation、Handoff、dry-run 和流式事件由同一 Runtime 执行，消息、Handoff Record、DryRun Report、实际 Model 快照和 Turn 结果由 SessionController 写回。

## Library 使用路径

Library 使用者可以从 Root Export 获得 `core`、`runtime`、`coding`、`memory` 和 `sessions` 的聚合能力，也可以通过 Subpath Export 控制依赖边界。Provider 通过独立子路径导入。Library 调用无需经过 CLI、TUI 或文件配置；调用方可以自行提供 Model、Runtime、Session Store、Memory Adapter、审批能力、delegate 和 Handoff target。

## 稳定约束

- 依赖只能沿图中方向流动，`core` 和 `runtime` 保持 Provider、Coding 与 UI 无关。
- Session 只持久化稳定、可序列化的数据，不保存 SDK Client、流、取消控制器或审批回调。
- Delegation 复用同一 Agent 与 Runtime 抽象，以 execution relationship 表达 parent-child。
- Handoff 复用同一 Execution Branch，以 predecessor-successor 表达串行接管。
- dry-run 由 Runtime 统一执行 Tool Effect 路由，mutation Tool 的 Preview 不进入持久提交路径。
- Memory 通过 Adapter 接入，不把文件存储或召回策略固化到 Runtime。
- CLI 与 Library 共享领域实现，不维护两套 Model、Agent Loop 或 Session 语义。
- 公共入口由源码 `index.ts`、构建入口、`package.json#exports` 和冒烟测试共同保护。

七个模块的详细职责见本目录各模块页面，动态关系见[Agent 执行流程](../workflows/agent-execution.md)和[能力地图](../overview/capability-map.md)。
