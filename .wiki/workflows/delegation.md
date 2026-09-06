---
title: Delegation
summary: 描述 delegate 注册、delegate_task、child execution、policy 隔离、调度限制、结果传播和取消级联。
sources:
  - src/runtime/delegation/
  - src/runtime/agent/runtime.ts
  - src/runtime/execution/
  - src/runtime/resources/
  - src/coding/agents/delegated-agents.ts
  - tests/runtime/delegation.test.ts
  - tests/coding/agents/delegated-agents.test.ts
related:
  - architecture/runtime.md
  - architecture/coding.md
  - workflows/agent-execution.md
  - workflows/tool-execution.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - architecture/memory.md
---

# Delegation

Delegation 让一个 Agent Execution 把自包含任务交给同一 Agent Group 中配置的 Delegate。Child 仍使用通用 Agent、Agent Loop 和 Execution；Sub-agent 的差异由 Parent-Child Execution Relationship、Delegate 配置与 Policy 表达。

## 注册与调用

Delegate Definition 包含稳定名称、用途说明、异步配置工厂和可选 policy。Agent 创建时注册可用 delegate。Runtime 仅在当前 Execution 确实拥有 delegate 时加入 `delegate_task` Tool，使 Model 看到可选择的名称与任务描述。

Model 调用 `delegate_task` 时只能提供 delegate 名称和任务。Runtime 先规范化请求，再验证 parent 仍可委派、名称已注册、深度、每 parent child 数、Tree Execution 数、Token 上限和递归规则。Model 不能直接指定 child 的 Tool、Skill、Middleware、权限或任意模型参数。

## child 创建与隔离

通过 preflight 后，Runtime 创建带 `parentExecutionId`、共享 `rootExecutionId`、递增 depth 和继承 Mode 的 child branch，并交给 Scheduler。获得 permit 后，delegate factory 接收 parent 身份快照、parent Model 和任务，构造 Agent Configuration；Runtime 再应用 policy 并用同一个 Runtime 创建 child Agent。

Child Transcript 始终从空消息开始，仅追加委派任务；Delegate Factory 可以把 Project Guidance 放入 Child Prompt。Model 由目标 Agent Profile 或 Delegate Factory 选择；Runtime Policy 可以进一步覆盖。Tool 与 Skill 默认均为空，只有 `explicit`、`inherit` 或目标 Profile 的显式 Policy 才授予；Memory 与 Middleware 由 Child Factory 显式组合。Terminal Agent Group 的 Edge 对目标 Profile 的 Tool 与 Global/Project Memory Policy 执行求交，不能提升目标能力。Child Delegate 只来自 Policy 或显式配置。Child 使用独立的进程内 Context State，并按自身 Model 的 Context Compaction Mode 决定是否启用；摘要 Usage 计入 Execution Tree，摘要节点不进入 root Session。

## 调度与资源

Scheduler 同时限制每个 parent、每棵 Execution Tree 和 Runtime 全局的并发 delegated execution。无 permit 的 child 进入 `queued`，获得 permit 后进入 `running`。nested parent 等待 child 时可以释放自己的 delegated permit，并在 child 完成后重新获取，状态活动字段反映等待 child 或等待 permit。

Runtime 还限制最大深度、每个 Execution 的 child 数、每棵 Tree 的 Execution 数、child timeout、child step 和 Tree Token Usage。精确默认值集中在 `DEFAULT_DELEGATION_LIMITS`，调用方可在 Runtime 构造时覆盖。

## 结果与可观察性

`delegate_task` 等待 child Branch Result。child 内发生 Handoff 时，最终 Agent 的结果作为该 branch 的输出。成功时返回截断后的文本摘要以及 execution、parent、root、状态、step、Usage 和 duration 元数据；非完成状态和 preflight 拒绝返回结构化错误。child 的完整 transcript 不进入 parent，只把该 Tool Result 作为观察结果注入 parent Agent Loop。

Runtime 可以按 execution ID 查询活动快照，按 root ID 查询 Execution Tree，并通过 subscription 观察状态。Child Execution 从创建时就使用目标 Delegate 的 Agent 身份，生命周期事件、Model Call Event 与 Session Effective Model 因而可以按同一 executionId 准确关联。Tree Usage 聚合所有 Execution 的 Token Usage；dry-run 下 child Tool Outcome 同时进入 root Tree Report。已完成 root Tree 以有限数量保留在内存中；当前实现不提供持久化 Execution Store。

## 取消与终止

parent Tool 等待使用当前 Execution AbortSignal。parent 取消、超时或终止时，Runtime 级联取消仍活动的 descendant，并从 Scheduler 队列或 permit 计数中释放。child 独立失败会作为结构化 Tool Error 返回 parent；parent 可以基于观察结果继续下一 step。

## Coding Agent 的默认策略

直接使用 Coding Factory 的默认组合时，`explore` 使用显式只读 Tool，不使用 Skill 与 Memory，也没有 Delegate；`general` 使用显式开发 Tool、继承 Parent Skill、装配 Global/Project read-only Memory，并可进一步委派给 `explore`。通过 Agent Group 创建的 Terminal Agent 以配置中的 Delegate Edge 和目标 Profile 为准；execute Mode 下的 Mutation Tool 继续经过 Coding Approval Middleware。

整体 Execution 主流程见[Agent 执行流程](agent-execution.md)，Delegation Tool 的回注方式见[Tool 执行流程](tool-execution.md)。
