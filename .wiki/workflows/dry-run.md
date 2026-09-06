---
title: dry-run
summary: 说明 dry-run 如何依据 Tool Effect 路由调用、生成 Preview，并聚合覆盖整个 Execution Tree 的报告。
sources:
  - src/core/tools/function-tool.ts
  - src/runtime/tools/
  - src/runtime/agent/
  - src/coding/tools/
  - src/coding/permissions/coding-approval-middleware.ts
  - src/sessions/session-service.ts
  - tests/runtime/handoff-dry-run.test.ts
related:
  - workflows/agent-execution.md
  - workflows/tool-execution.md
  - workflows/delegation.md
  - workflows/handoff.md
  - architecture/memory.md
---

# dry-run

dry-run 是 Execution Tree 的运行模式。Model、Agent Loop、安全读取、交互和 Runtime 控制能力继续运行，声明为持久修改的 Tool 只计算 Preview。结果同时包含 Agent 输出和 Tree 级 DryRun Report，使调用方能够区分已读取事实、计划变更、受阻操作与不确定结果。

## 不可降级的模式

root AgentRun 在启动时确定 `execute` 或 `dry_run`。mode 是 Execution 与 Branch 的只读属性，Delegation child 和 Handoff successor 从来源 Execution 继承，Delegate Policy、Handoff Factory、Middleware 与 Model 均没有提升为 execute 的入口。

dry-run 指令在全部 `beforeModel` Middleware 完成后追加到固定 Model Context，再进入 Context Manager 的 Token 估算和组装。Model 因此能够主动调用相关 Tool 获得结构化 Preview，而不是仅生成自然语言计划。

## Tool Effect 路由

每个 Tool 声明 effect kind、scope 和描述。ToolExecutor 在 execute mode 调用 `execute`；在 dry-run 中按 kind 路由：

| Effect        | dry-run 行为                                 |
| ------------- | -------------------------------------------- |
| `read`        | 执行受控读取                                 |
| `ephemeral`   | 更新当前 Execution 的临时状态                |
| `interaction` | 执行用户交互                                 |
| `control`     | 执行 Delegation、Handoff 等 Runtime 控制操作 |
| `mutation`    | 调用 `preview`，不进入 `execute`             |
| `unknown`     | fail-closed                                  |

mutation Tool 缺少 Preview、Preview 抛错或返回无效结构时形成 blocked Outcome。Library 可以启用 `strictToolRegistration`，在 Agent 创建阶段拒绝 unknown effect 和缺少 Preview 的 mutation Tool。官方 Tool 均使用显式 effect。

## Preview 契约

Preview 描述 planned、no_change 或 indeterminate 状态，并提供 operation、resource、warning、confidence 和可选 fingerprint。它可以读取当前状态并在内存中计算差异，不创建目标文件、临时文件、Lock、子进程、外部草稿或持久授权。

Runtime 在 Preview 进入 Model Context、Event 和 Session 前验证可序列化结构，限制字符串与整体大小，并清理常见凭据。Preview 是基于当前观察生成的结果；未来 execute 会重新读取状态、校验参数并执行 Approval。

## Middleware 与 Approval

Middleware 通过 `compatible`、`skip` 或 `forbidden` 声明 dry-run 策略。compatible Hook 正常执行，skip Hook 在该模式下跳过，forbidden 会在 Agent 接管 Execution 时终止运行。Skills、Todo、Memory 和 Coding Approval 都显式声明策略。

Coding Approval Middleware 在 dry-run 中不发起批准请求，也不写项目 Allow List。mutation 调用经过参数校验和必要的输入变换后进入 Preview；查看 Preview 不产生未来执行授权。

## Tree Report

Runtime 为 rootExecutionId 建立一个 DryRunReportBuilder。root、Delegation child 和 Handoff successor 的 Tool Outcome 都写入同一报告，并保留 executionId、branchId、agentId、Tool、effect 和 disposition。Handoff 共享 branch，Delegation 使用独立 child branch；两类调用均保留准确归属。

Report 汇总真实执行的 read、ephemeral、interaction、control，以及 preview、no-change、blocked 和 indeterminate 数量。存在 blocked 的正常结束标记为 partial。Session 在 dry-run Turn 中保存 mode 和清理后的 Report；TUI 持续显示当前 mode，Turn 结束后显示 preview、blocked 计数和 Report 的 Session 归属。
