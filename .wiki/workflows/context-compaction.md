---
title: Context 压缩
summary: 说明 Autryn 如何基于显式 Model 能力配置，在 Model 调用前构建有界 Context 并持久化可恢复的摘要状态。
sources:
  - src/runtime/context/
  - src/runtime/agent/agent.ts
  - src/sessions/session-types.ts
  - src/sessions/session-schema.ts
  - src/sessions/session-service.ts
  - src/terminal/config/schema.ts
  - src/terminal/session/
  - tests/runtime/context-manager.test.ts
  - tests/runtime/context-frontier.test.ts
  - tests/sessions/session-service.test.ts
  - tests/terminal/session/model-resolver.test.ts
related:
  - architecture/runtime.md
  - workflows/agent-execution.md
  - workflows/session-lifecycle.md
  - architecture/memory.md
  - workflows/dry-run.md
  - interfaces/configuration-and-storage.md
---

# Context 压缩

Context 压缩在每次 Model 调用前为当前 Agent 构建有界输入。Agent 与 Session 保存完整 canonical transcript；压缩结果只影响本次发送给 Provider 的 ModelContext，并通过 Session compaction 状态保存可复用摘要节点。

## 预算

Model 配置必须提供 `contextWindowTokens`。`maxOutputTokens` 可单独配置，缺省使用终端默认输出上限。Runtime 根据 Context Window、输出预留、安全余量、触发比例和目标比例计算输入预算；终端 Agent 在自身 Model 的 `contextCompactionMode` 未关闭时启用 ContextManager。候选输入超过触发预算是生成摘要的唯一条件；checkpoint 只保存可恢复 frontier，不参与触发判断。

TokenEstimator 使用 Provider-neutral 的保守估算。估算覆盖 prompt、Middleware 注入内容、固定 Execution Mode 指令、Message、Content Block、Tool 定义、Tool Schema、图片和结构开销。它服务于发送前的预算控制，不替代 Provider 返回的实际 Token Usage。

## 摘要图

RuntimeContextManager 将较早历史按 Message Block 和 Turn 边界压缩。Message Block 保持 Tool Use 与 Tool Result 的协议关系，同一 Assistant Message 发起的 Tool 调用及其结果作为整体进入 Raw Tail 或摘要输入。

摘要节点按 Turn、Segment、Phase、Session 四个层级组织。Turn 节点来自完整 Turn 范围，Segment 节点聚合同一 Phase 内的连续 Turn Summary。Completed Phase 形成 Final Phase Node；Active Phase 在包含多个 Closed Segment 或预算继续收紧时形成 Phase Checkpoint。Session Node 只聚合 Completed Phase 的 Final Node 或既有 Session Node，Active Phase 不进入 Session Summary。节点创建后不可变，并保存来源范围、子节点、结构化摘要、渲染文本、估算 Token、策略版本、摘要 Schema 版本、生成 Model 快照和摘要调用 Usage。

RuntimeContextManager 以非重叠摘要节点和未压缩 Raw Tail 组装 frontier。首次压缩前估算完整输入；已有有效 frontier 后，只估算 frontier 摘要、完整 Raw Tail、prompt 与 Tool 定义。候选未超过触发预算时，新增 Turn 保持 raw，不调用摘要模型，也不更新 checkpoint。候选超限时，从 Raw Tail 最老端选择足以接近目标预算的最短连续完整 Turn 前缀；`recentTurns` 只定义普通保护后缀。实际摘要后仍高于目标预算时继续扩展该前缀，只有超过硬输入预算才从受保护历史的最老完整 Turn 开始紧急压缩。

Completed History 可以提升为 Session Summary，Active Phase 只能提升为 Phase Checkpoint。当前 User Message 始终以原文保留；历史压缩仍无法满足硬预算时，当前 Turn 中较早的完整 Message Block 通过进程内 Checkpoint 增量重摘要，最新 Block 保持 raw。若单个 Tool Result 仍使输入超限，Runtime 在 ModelContext 克隆中优先保留结构化摘要与错误信息，或保留原始文本首尾片段；Agent transcript 与 Session transcript 保持完整。完整 Block 经过压缩与 Context-only Reduction 后仍然超限时，Runtime 以结构化 Context 错误终止当前 Step。

## 摘要模型

ModelContextSummarizer 使用独立 Model 调用生成结构化 JSON 摘要，不启用 Tool，不进入 Agent Loop。终端配置可以通过 `contextCompaction.summaryModelConfigId` 指定专用摘要模型；缺省使用当前 Agent Model 的派生实例，并关闭主生成参数中的 thinking。摘要输出通过 Zod 校验，失败后执行一次修复请求。

## Session 状态

Session Record 的 `compaction` 字段保存 Phase、CompactionNode 和 checkpoint。checkpoint 记录来源 revision、策略版本、摘要 Schema 版本和当前 `frontierNodeIds`；最后一个 frontier 节点的来源终点直接确定 Raw Tail 起点，不保存额外滑动游标。Frontier 必须从首条 Session Message 开始形成连续、无重叠且无 Parent/Descendant 共存的精确前缀。恢复时完整校验版本、来源锚点、子图、Phase 与 frontier，不满足不变量则从 canonical transcript 重建；同一 ContextManager 后续只复核可变锚点，不重复扫描稳定历史。

压缩更新以 `appendNodes + checkpoint` 原子提交，新节点写入失败时不会推进已提交基线，相同更新不增加 Session revision。Phase 完成时，Active Phase Checkpoint 先展开为已持久化 children；预算再次触发并覆盖该范围时才生成 Final Phase Node。Session Clear 清空 transcript 时将 compaction 重置为空状态。Model 切换只重新计算本次预算，策略与摘要 Schema 兼容的节点继续复用。

Global 与 Project Memory bootstrap 由 MemoryMiddleware 作为当前调用的固定 Prompt 内容注入，并完整计入输入预算。bootstrap 和 Topic Document 不生成 CompactionNode；通过 `memory_read` 返回的 Tool Result 作为普通 Transcript 历史参与压缩。两类状态边界见[Memory](../architecture/memory.md)。

Handoff successor 继续 Root Branch 的 Context Runtime，并按 successor Model 的 Context Window 重新计算预算；Delegation Child 使用独立 ContextManager。Memory 不进入 Session Transcript，也不生成 CompactionNode。

`phase_transition` 只属于 Session 的 root Branch，并仅向当前 Model 启用 Context Compaction 的 Agent 暴露。Root Handoff successor 按自己的 Model Capability 决定是否获得该 Tool，Delegation child 不写 root Session Phase。Tool 登记下一阶段目标；当前 Turn 成功完成后，SessionService 关闭 active Phase 并保存 `nextPhaseObjective`，下一 Turn 开始时创建新的 active Phase。

## 稳定约束

- ContextManager 在全部 `beforeModel` Middleware 完成后运行。
- Context 压缩不写回 Agent transcript，也不改写 Session canonical messages。
- Middleware 产生的非 canonical 消息视图只做本次调用的临时重建，不写入 Session compaction 状态。
- 当前 User Message 不进入临时摘要或字符串截断路径。
- Session Summary 不引用 Active Phase 的 Segment 或 Checkpoint。
- Tool Use、Tool Result、Delegation Result、Handoff Result 和 dry-run Outcome 不在 Context 中脱离对应协议关系。
- 摘要调用 Usage 计入当前 Execution，Context Event 只携带元数据。
- API Key、SDK Client、AbortController、streaming 标记、thinking 和 child transcript 不进入 compaction 状态。
