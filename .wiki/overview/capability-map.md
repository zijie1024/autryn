---
title: 能力地图
summary: 展示 Autryn 的主要能力、所属模块以及从终端输入到 Model、Tool、Execution Tree、Memory 和 Session 的连接关系。
sources:
  - src/core/
  - src/runtime/
  - src/sessions/
  - src/memory/
  - src/coding/
  - src/terminal/
  - src/providers/
related:
  - overview/project.md
  - architecture/system.md
  - workflows/agent-execution.md
---

# 能力地图

Autryn 的能力从稳定基础抽象向具体应用逐层组合。`core` 定义跨 Provider 的语言，`runtime` 执行 Agent，`sessions` 保存 root 对话，`memory` 保存分层的长期知识，`providers` 连接模型服务，`coding` 提供开发场景能力，`terminal` 将这些部分装配为 CLI 与 TUI。

## 能力关系

```text
CLI / TUI
   │
   ├── SessionController ──→ Session Service / Store
   │          ├──→ Agent Registry
   │          └──→ Model Resolver ──→ Provider
   ├── Memory Adapter ──→ Memory Store / Retriever
   │
   └── Coding Agent ──→ Agent Runtime ──→ Model
             │                 │
             ├── Coding Tool   ├── Tool execution
             ├── Skill         ├── Middleware
             ├── Approval      ├── Delegation / child branch
             ├── Memory        ├── Handoff / branch successor
             └── AGENTS.md     └── dry-run / tree report

core: Model + Message + Tool contracts
```

## 核心能力

| 能力                  | 主要所有者         | 作用                                                              |
| --------------------- | ------------------ | ----------------------------------------------------------------- |
| Model 与 Message      | `core`             | 为不同 Provider 和 Runtime 提供统一请求、响应与 transcript 契约   |
| Tool                  | `core` + `runtime` | 定义 Zod 参数和调用契约，并在 Agent Loop 中校验、执行和回注结果   |
| Agent Loop            | `runtime`          | 循环完成 Model 调用、Tool 调用和终止判断                          |
| Execution             | `runtime`          | 表示一次可观察、可取消、具有状态和用量的 Agent 运行               |
| Execution Branch      | `runtime`          | 连接由 Handoff 串行接管的 predecessor 与 successor Execution      |
| Middleware            | `runtime`          | 在 Agent、step、Model 与 Tool 生命周期点观察或调整上下文          |
| Delegation            | `runtime`          | 将自包含任务交给注册的 delegate，形成受限的 child execution       |
| Handoff               | `runtime`          | 在同一 Branch 内结束当前 Execution 并把控制权交给目标 Agent       |
| dry-run               | `runtime`          | 根据 Tool Effect 执行安全动作或生成 Preview，并聚合 Tree Report   |
| Session               | `sessions`         | 持久化 root transcript、Turn、Agent Group、Model 快照和工作区身份 |
| Global/Project Memory | `memory`           | 通过 Adapter 保存和召回分层的长期知识                             |
| Provider              | `providers`        | 在统一契约与 OpenAI/Anthropic API 之间转换消息、Tool 和流         |
| Coding Agent          | `coding`           | 组装开发 Tool、审批、Skill、Todo、项目指导和默认 delegate         |
| CLI / TUI             | `terminal`         | 提供配置、Session 操作、交互输入、渲染和用户审批                  |

## 运行连接

用户提交输入后，SessionController 重新加载当前配置，在 Turn 边界冻结 Session 的 Agent Group、active Agent、有效 Model 与 Capabilities，并捕获 Execution Mode、Memory 与 Approval 状态。Agent Runtime 建立 root Execution，Agent Loop 通过 Provider 流式调用模型。模型发出 Tool Use 时，Runtime 校验参数并根据 Execution Mode 与 Tool Effect 进入 execute 或 Preview 路径；结果被规范化为 Tool Result 后回到 transcript，进入下一 step。

模型调用 `delegate_task` 时，Runtime 根据当前 Execution 注册的 delegate 创建 child branch。child 使用独立 transcript，并按目标 Agent Profile 获得 Model、Tool、Skill、Memory 和 delegate。模型调用 Handoff Tool 时，Runtime 在当前 Branch 建立 successor Execution，目标 Agent 接管剩余任务；root Handoff 的最终 Agent 会成为 Session 下一 Turn 的 active Agent。

root branch 产生的用户、Assistant 和 Tool 消息按 Turn 持久化到 Session。每个 Execution 真正开始 Provider 调用时，Runtime 发布带准确 Agent 身份的 Model Call Event，Session 由此增量记录实际 Effective Model。dry-run Turn 同时保存 Mode 和 DryRun Report。Memory 的索引通过 Middleware 注入有界 Context，详细知识由 Tool 按需读取；Memory Document 不进入 Session transcript。

能力之间通过有类型的对象连接：ModelContext 承载模型输入，Execution Event 承载运行观察，Execution Branch Result 连接 Runtime 与 Turn，Session Record 承载会话状态，Memory Adapter 连接 Agent 与长期知识存储。审批和用户提问由调用方注入，使 Library 使用不依赖 TUI。

## 进一步阅读

静态边界见[系统架构](../architecture/system.md)。动态主流程分别见[Agent 执行流程](../workflows/agent-execution.md)、[Tool 执行流程](../workflows/tool-execution.md)、[Delegation](../workflows/delegation.md)、[Handoff](../workflows/handoff.md)、[dry-run](../workflows/dry-run.md)和[Session 生命周期](../workflows/session-lifecycle.md)。
