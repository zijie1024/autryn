---
title: Handoff
summary: 说明 Agent 如何在同一 Execution Branch 内转移控制权，并保持 Context、资源限制和跨 Turn Agent 连续性。
sources:
  - src/runtime/agent/runtime.ts
  - src/runtime/execution/
  - src/sessions/session-service.ts
  - src/terminal/session/agent-registry.ts
  - src/terminal/session/session-controller.ts
  - tests/runtime/handoff-dry-run.test.ts
  - tests/terminal/session/session-controller.test.ts
related:
  - workflows/agent-execution.md
  - workflows/delegation.md
  - workflows/session-lifecycle.md
  - workflows/dry-run.md
---

# Handoff

Handoff 将同一逻辑任务的后续控制权交给另一个 Agent。一次 Handoff 会结束当前 Execution，并在原 Execution Branch 中建立 successor Execution；Branch 的 transcript、mode、累计 step、Token Usage 和资源限制继续生效。它适合专业角色接管任务，不创建并行 parent-child 关系。

## Branch 模型

Execution 绑定一个固定 Agent，Execution Branch 表示可以由多个 Agent 串行接管的连续运行。Handoff commit 后，predecessor 进入 `handed_off`，successor 继承原 branchId、rootExecutionId、depth、mode 和 branch deadline。Branch 只有在最终 Execution 完成、失败、取消、超时或超过限制时才产生结果。

Branch Result 同时包含 initial/final Execution、initial/final Agent、Handoff Record、累计 Usage 和最终输出。Delegation child 也使用 Branch，因此 child 内部可以发生 Handoff，而 parent 只接收 child branch 的最终结果。

## 定义与入口

Agent 通过 `HandoffDefinition` 注册目标 AgentId、说明、Zod 输入 Schema、目标配置 Factory 和可选 Context Policy。Runtime 为每个目标生成独占的 `handoff_to_<target>` Tool；程序化调用使用相同控制器和校验流程。

一次 Model Message 中的 Handoff Tool 必须独占。Runtime 在创建 successor 前完成 source 状态、目标注册、输入、Middleware、访问次数、Execution Tree 和 Token 限制校验。并发 Handoff 由 source 级 in-progress guard 串行化，已发生转移的 predecessor 不能再次提交。

## Context 与能力

`continue` 策略把 canonical branch transcript 和 Handoff 确认结果交给 successor。`filter` 策略可以收缩输入视图，输出仍须保持 Message Block 完整，并保留当前 User 任务、Handoff Tool Use 与对应 Tool Result。无效视图以 `HANDOFF_CONTEXT_INVALID` 拒绝，不影响 predecessor 继续运行。

successor 使用 Factory 返回的完整 Agent 配置。Model、prompt、Tool、Middleware、Delegate 与 Memory 均由目标配置显式组合；Runtime 不从 predecessor 复制能力对象。Branch 级 Context State 在接管链中复用，是否为当前调用启用压缩以及采用怎样的 Token Budget，则由 successor Model Capability 决定。Handoff 继承执行约束，不继承 predecessor 的应用能力。

## Session 连续性

root branch 的 Handoff Record 写入当前 Turn。SessionController 在 commit Event 到达时更新 `activeAgentId`，Turn 结束时再用 Branch Result 校验最终 Agent。下一 Turn 由 Application 的 Agent Registry 按该 ID 重建 Agent；目标未注册时 Session 呈现 `agent_missing`，不会静默回退到 Code Agent。

TUI 直接消费结构化 Handoff Event，显示 source、target 与 preparing、committed、rejected 状态；Footer 持续显示当前 active Agent，Branch 完成后显示最终接管结果。展示内容不解析 Tool Result，也不展开 Handoff 业务输入。

取消通过 AgentRun 指向 Branch 当前 Execution，因此 predecessor 完成转移后，原始调用方仍能终止 successor。delegated branch 的 deadline 在 Handoff 链中保持不变，接管不会重新获得完整 Timeout。

## 与 Delegation 的边界

Delegation 创建 child branch，parent 保留控制权并等待结果，适合任务拆分和并行协作。Handoff 在当前 branch 内串行更换 Agent，predecessor 不等待恢复。两者共享 Execution、Event、取消和资源账本，并通过不同的拓扑表达协作语义。
