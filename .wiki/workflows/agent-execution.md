---
title: Agent 执行流程
summary: 描述用户输入从 root Execution Branch 创建、Model step、Tool 循环、Delegation 与 Handoff 到最终结果的完整流程。
sources:
  - src/runtime/agent/agent.ts
  - src/runtime/agent/runtime.ts
  - src/runtime/execution/
  - src/runtime/events/
  - src/terminal/session/session-controller.ts
  - tests/runtime/agent.test.ts
related:
  - architecture/runtime.md
  - workflows/tool-execution.md
  - workflows/delegation.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - workflows/context-compaction.md
  - workflows/session-lifecycle.md
---

# Agent 执行流程

一次 AgentRun 由 Runtime 创建 root Execution Branch，并拥有明确的生命周期、事件流、取消信号和最终结果。Agent Loop 在 branch transcript 上交替进行 Model 调用与 Tool 执行；没有 Tool Use 的 Assistant Message 表示当前 Execution 完成，Handoff 则由 successor 继续同一 Branch。

## 启动

CLI 路径中，SessionController 在 Turn 开始时冻结 Session 的 Agent Group、Agent Model、Capabilities 和 Mode，用 Agent Registry 根据 `activeAgentId` 创建 Agent。用户输入被构造为 User Message。`Agent.execute` 要求当前 Agent 没有 active run，并调用 `AgentRuntime.startRoot` 建立 depth 0、`id` 与 `rootExecutionId` 相同的 Execution；冻结的 Mode 决定该 Tree 使用 execute 或 dry-run。

Runtime 先发布 `created` 生命周期，随后在 microtask 中把 Execution 切换到 `running` 并进入 `runExecution`。Agent 将 User Message 同时追加到自身 context 与 Execution 消息快照，然后按顺序运行 `beforeAgentRun` Middleware。

## Step 循环

每个 step 按以下顺序执行：

1. 检查 Execution AbortSignal，并记录 step 数。
2. 串行运行 `beforeAgentStep`。
3. 构造 ModelContext：system prompt、当前 transcript、有效 Tool 与 AbortSignal。
4. 串行运行 `beforeModel`，附加固定 Mode 指令，启用 ContextManager 时构建有界 ModelContext。
5. 通过 ModelProvider 读取累积流式快照。
6. 流式阶段发布 thinking 或最新 Tool Use 的 progress event。
7. 最终快照记录 Token Usage、移除 streaming 标记，并追加为 Assistant Message。
8. 运行 `afterModel`，发布完成的 Message Event，并检查 Execution Tree Token 上限。
9. 若 Assistant Message 没有 Tool Use，运行 `afterAgentRun`，以文本与安全化 Assistant Message 完成 Execution。
10. 若存在 Tool Use，ToolExecutor 根据 Mode 与 Effect 执行、预演或阻止调用，并按完成顺序回注 Tool Message；全部完成后运行 `afterAgentStep`，进入下一 step。

Model 流没有产生任何快照属于失败。达到 Agent step 上限或 Tree Token 上限产生 `limit_exceeded`，不会被伪装为普通完成。

## 事件与结果

Execution Event 包含稳定 execution、parent、root、depth、sequence 和 timestamp。生命周期事件表示状态变化；Agent Event 表示完成消息或流式进度。`Agent.stream` 对 Library 调用方暴露兼容的 Agent Event；Runtime `subscribe` 通过 Execution Snapshot 提供诊断侧信道。

Context Event 表示压缩开始、完成或失败，只包含层级、估算 Token、节点 ID 和结构化错误等元数据。Runtime 在真正进入 Provider Stream 前发布不含敏感内容的 Model Call Event，供 Session 按 Execution 记录实际 Model 使用。摘要正文和 Session compaction 状态不通过事件流暴露。

Execution Result 包含终止状态、step、聚合到该 Execution 的 Token Usage、持续时间和可选结构化错误。Execution Branch Result 进一步包含 initial/final Agent、initial/final Execution、累计 Usage 和 Handoff Record。dry-run root 结果包含覆盖完整 Tree 的 DryRun Report。Runtime 可以按 root ID 返回 Execution Tree Snapshot，并聚合所有已知 Execution 的 Usage。

## 取消、Timeout 与失败

`Agent.abort` 取消 active Branch 的当前 Execution，包括 Handoff 后的 successor。Execution 的 AbortController 同时连接 Model 调用、Tool 调用和等待 child 的过程。取消产生 `cancelled`；child timeout 产生 `timed_out`；未处理的 Model 或 Middleware 异常产生结构化失败。Execution 进入终止状态后不再接受后续结果，并关闭事件队列。

root 或 parent 终止时，Runtime 取消仍在运行的 descendant。完成的 root Tree 被保留为有限快照，然后活动记录被清理。SessionController 消费最终结果并结束对应 Turn；Session 语义见[Session 生命周期](session-lifecycle.md)。

## 稳定约束

- 同一个 Agent 同时只运行一个 AgentRun。
- Middleware 保持注册顺序；Model 与 Tool 共享 Execution AbortSignal。
- ContextManager 位于 `beforeModel` 之后，摘要调用 Usage 计入当前 Execution。
- Assistant 与 Tool Message 先进入 transcript，再用于下一次 Model step。
- Delegation child 与 Handoff successor 使用相同 Agent Loop，差异来自 Tree 拓扑和显式配置。
- execute 与 dry-run 共享 Agent Loop，mutation Tool 只在 execute 路径提交副作用。
- 取消、超时、失败和限制是不同的终止状态，调用方可以可靠区分。

Tool 内部流程见[Tool 执行流程](tool-execution.md)，child 流程见[Delegation](delegation.md)，Agent 接管见[Handoff](handoff.md)，预演语义见[dry-run](dry-run.md)。
