---
title: runtime 模块
summary: 说明 runtime 如何统一管理 Agent Loop、Execution Branch、Middleware、Context 压缩、Delegation、Handoff、dry-run 与资源控制。
sources:
  - src/runtime/
  - tests/runtime/
related:
  - architecture/system.md
  - architecture/core.md
  - workflows/agent-execution.md
  - workflows/delegation.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - workflows/context-compaction.md
  - workflows/tool-execution.md
---

# runtime 模块

`runtime` 是 Autryn 的通用 Agent 执行层。它在 `core` 契约之上管理 Agent Loop、Execution Branch、事件、Middleware、Context 压缩、Tool Result、Todo、Skill、Delegation、Handoff、dry-run、调度与资源用量，同时保持 Coding、Provider、Memory、Session 和终端无关。

## 核心模型

`Agent` 持有身份、Model、prompt、transcript、Tool、Skill、Middleware、step 上限、delegate 和 Handoff 定义。`execute` 在关联的 `AgentRuntime` 中启动 root Execution；`stream` 将 Execution Event 中的消息和进度映射为兼容的 Agent Event。Agent 同一时刻只运行一个 active Execution。

`AgentExecution` 是一个 Agent 的一次运行实体，维护身份、parent/root 关系、branch、深度、mode、deadline、状态、活动阶段、step、Token Usage、错误、事件序列、AbortSignal 和最终结果。Execution Branch 连接 Handoff predecessor 与 successor；`AgentRuntime` 创建并追踪 Execution Tree，注册观察者，保留有限数量的已完成 Tree 快照，并在 root branch 完成后清理活动记录。

Delegation 由 delegate 定义、`delegate_task` Tool、Runtime preflight、Scheduler 和 child Agent 共同完成。资源边界集中在 `DelegationLimits`；Tool 与 Skill 继承由显式 policy 决定。详细过程见[Delegation](../workflows/delegation.md)。

Handoff 在当前 Branch 中建立 successor Execution，目标 Agent 接管后续控制流，并继承 branch transcript、mode、累计 step、Token Usage 与 deadline。详细过程见[Handoff](../workflows/handoff.md)。

## Middleware 与辅助能力

Middleware Hook 按数组顺序串行执行，覆盖 Agent run、step、Model、Tool 和 Handoff 边界。Hook 可以返回 partial context；`beforeToolUse` 还可以变换已校验输入或返回结构化拒绝结果。Skill Middleware 发现 Skill 并把目录与显式选择加入 prompt。Todo 系统以 Tool 与 Middleware 组合维护单次 Agent 实例中的任务状态。

ToolExecutor 根据 Execution Mode 与 Tool Effect 选择 execute 或 Preview。Preview 先经过结构验证、大小限制和敏感内容清理；全部 Tool Outcome 由 Tool Result Runtime 规范化，再依据 Tool Policy 控制注入 Model Context 的信息和长度。完整语义见[Tool 执行流程](../workflows/tool-execution.md)和[dry-run](../workflows/dry-run.md)。

Runtime Event 与 Execution Tree 构成可观察性边界。调用方可以订阅状态快照和 Model Call Event、读取活动 Execution，或在 root 完成后查询保留快照，而不需要访问 Agent 的可变内部 context。Model Call Event 以真实 Provider 调用边界为事实来源，并携带 execution、branch 与 Agent 身份，不暴露 prompt、消息或密钥。

ContextManager 在 `beforeModel` Middleware 完成后、Provider 调用前构建有界 ModelContext。它按 Message Block、Turn、Segment、Phase 和 Session 层级生成摘要节点，并通过 Context Event 暴露压缩元数据。完整语义见[Context 压缩](../workflows/context-compaction.md)。

## 依赖与协作

`runtime` 只依赖 `core`。Provider 通过 Model 间接参与调用；Coding Agent 向 Runtime 提供 Tool、Middleware、Skill 与 delegate；SessionController 消费 Execution Event 和 Result，但 Session 持久化不进入 Runtime。

## 稳定约束

- Runtime 不包含文件编辑、Shell、具体 Provider、Memory Adapter、终端渲染或项目设置逻辑。
- Context 压缩不改写 Agent transcript；Session 持久化通过终端组合层注入的回调完成。
- root、Delegation child 和 Handoff successor 复用同一 Agent Loop 与 Execution 模型。
- 每次 Model 流的最终快照形成 Assistant Message；存在 Tool Use 时才进入 Tool 执行和下一 step。
- 参数在统一调用边界按 Tool Schema 校验；Tool Result 以完成顺序逐个回注 transcript。
- 取消、timeout、step 和 Token 限制以结构化终止状态表达，并沿 Execution Tree 传播。
- Execution Mode 在 root 启动时确定，Delegation child 与 Handoff successor 只继承该值。
- Delegation 默认限制的精确值以 `src/runtime/execution/types.ts` 为唯一来源。

主循环见[Agent 执行流程](../workflows/agent-execution.md)，Tool 调用见[Tool 执行流程](../workflows/tool-execution.md)。
