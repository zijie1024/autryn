---
title: sessions 模块
summary: 说明 sessions 如何建模并持久化 Session、Agent Group、Active Agent、Turn、Execution Mode、revision、lease 与健康状态。
sources:
  - src/sessions/
  - tests/sessions/
related:
  - architecture/system.md
  - workflows/session-lifecycle.md
  - workflows/model-selection.md
  - workflows/context-compaction.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - interfaces/configuration-and-storage.md
---

# sessions 模块

`sessions` 是独立的持久化领域，保存用户与 root Execution Branch 的长期对话状态。它定义 Session、Turn、Message Record、Handoff Record、DryRun Report、Store、选择器、健康状态、revision 和 lease，并通过内存与文件实现支持测试和本地 CLI。

## 领域模型

Session Record 包含稳定 UUID、递增 revision、可选名称、创建与更新时间、工作目录及项目标识、Agent Group、`activeAgentId`、Agent 级 `agentModelOverrides`、`activeExecutionMode`、持久消息、Turn 和 compaction 状态。Turn 记录冻结的 Group Revision、初始与最终 Agent、一个或多个有效 Model 快照、Execution Mode、状态、时间、root Execution ID、用量、Handoff、可选 DryRun Report 和经过清理的错误。持久消息通过 Turn ID 关联请求，并保存提交时间。

Session 草稿已经拥有 ID、工作区、Agent Group、Active Agent、Agent Model Overrides 与 Execution Mode，但尚未写入 Store。首次需要保存名称、Agent Override、Mode 或 Turn 时，SessionService 将其物化为 revision 1 的 Record。该设计让无实际交互的启动不会留下空 Session 文件。

## Store 与一致性

`SessionStore` 定义 list、load、acquire、commit 和 delete。Memory Store 提供同进程实现；File Store 在 `AUTRYN_HOME/sessions` 下为每个 Session 建立目录，以递增 revision JSON 保存快照，并通过 lease 文件保证单写者。

写入必须持有 lease，并以 expected revision 提交下一 revision；版本不匹配会产生冲突。File Store 使用临时写入与重命名形成原子更新，保留当前和前一 revision。Clear 使用 intent 与专门提交路径，确保清空 transcript 的持久语义可以在维护阶段确认。

## 选择与健康

Session Selector 支持完整 ID、至少八位且唯一的 ID 前缀、精确名称；匹配不唯一会显式失败。列表按项目标识过滤并按更新时间排序。健康状态可以表达可用、Model 缺失、Agent 缺失、工作目录缺失、锁定、损坏、Clear 待处理和持久化错误；Model 与 Agent 是否存在由终端组合层结合当前 Registry 判断。

## 依赖与协作

该模块使用 `core` 的非 system Message 类型和 `runtime` 的 Execution Branch Result、Handoff Record、DryRun Report、CompactionNode，但不依赖 TUI。SessionController 在 Turn 边界调用 SessionService，并负责把 Runtime Event 中完成的消息、已提交 Handoff 与最终结果写入 Record。

## 稳定约束

- 启动新会话、恢复、清空、重命名、删除和 Model 切换保持各自明确语义。
- Session 保存 root branch transcript；Delegation child branch 消息留在 Runtime，不进入 Session。
- root Handoff 更新 `activeAgentId`，下一 Turn 由应用层 Agent Registry 根据 Group 与 Overrides 重建对应 Agent。
- dry-run Turn 保存 Execution Mode 与清理后的 Tree Report，Session 默认 Mode 可独立切换。
- 一个 Turn 可以记录 Execution Tree 中实际发起 Model Call 的各 Agent 的 Effective Model；Delegation Child 的 Transcript 仍不进入 Session。
- Compaction 状态保存摘要节点、Phase 和 checkpoint；Clear 清空 transcript 时同步清空该状态。
- thinking、流式标记和不可持久化对象不会写入 Session Record。
- API Key、SDK Client、AbortController、流和审批回调不属于 Session Schema。
- 所有磁盘路径由 Home 与 Session Path helper 计算，并验证 ID 不能逃逸 Session 根目录。

完整动态过程见[Session 生命周期](../workflows/session-lifecycle.md)，存储位置见[配置与存储](../interfaces/configuration-and-storage.md)。
