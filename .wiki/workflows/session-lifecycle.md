---
title: Session 生命周期
summary: 描述 Session 从草稿创建到 Agent Group、Active Agent、Mode、Turn 持久化、revision、恢复、清空和删除的完整生命周期。
sources:
  - src/sessions/
  - src/terminal/index.tsx
  - src/terminal/session/session-controller.ts
  - src/terminal/commands/session.ts
  - tests/sessions/
  - tests/terminal/session/session-controller.test.ts
related:
  - architecture/sessions.md
  - workflows/agent-execution.md
  - workflows/model-selection.md
  - workflows/context-compaction.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - interfaces/configuration-and-storage.md
---

# Session 生命周期

Session 是用户与 root Execution Branch 对话的持久化边界。它保存 Workspace、Agent Group、Active Agent、Agent 级 Model Override、canonical transcript、Turn 和派生的 Context Compaction 状态。Memory 独立保存长期知识。

直接启动 Autryn 创建新的未保存草稿；只有发生需要保存的操作时才物化。恢复行为通过启动参数、Slash Command 或非交互 Session Command 明确触发。

## 创建与物化

无 `--continue` 或 `--resume` 启动时，SessionController 根据当前工作目录、Default Agent Group 和启动 Mode 创建草稿。草稿立即获得稳定 UUID、Workspace、Project Key、`activeAgentGroupId`、Group 的 Entry Agent、空的 `agentModelOverrides` 与 `activeExecutionMode`，但没有磁盘目录和 revision。

首次重命名、切换 Agent Model、切换 Mode 或开始 Turn 前，Controller 取得 create lease，SessionService 写入 revision 1 的 Record。`/new` 释放当前 lease 并创建新的草稿；新草稿使用 Default Agent Group 的 Entry Agent 与当前 Mode。尚未物化的草稿被删除时只替换为新草稿，不执行磁盘删除。

## Turn 持久化

一次用户请求按以下顺序持久化：

1. 重新读取并校验当前配置，随后校验 Workspace、Agent Group、Active Agent 和 Agent Model Override；
2. 根据 Group 与 Override 创建 Frozen Agent Group，得到覆盖 Agent 图、能力策略、有效 Model Capability 与摘要模型绑定的 Group Revision；
3. 物化 Session，并创建状态为 `running` 的 Turn；
4. 写入 User Message；
5. 通过统一 Agent Factory 创建 Active Agent，并使用历史 root Branch Transcript；
6. 每个完成的 Assistant 或 Tool Message 到达时立即追加到该 Turn；Handoff Commit 同步记录 Handoff 并更新 Branch 的 Active Agent；
7. Runtime 在每个 Execution 真正进入 Provider Stream 前发布 Model Call Event，Session 按 Execution 幂等追加非敏感 Effective Model；Branch 结束后写入 Turn 状态、root Execution ID、Mode、Usage、Handoff、可选 DryRun Report、结束时间和经过敏感信息清理的错误。

进程中断后仍为 `running` 的 Turn 在恢复时标记为 `interrupted`。Session 保存 root Branch 的对话，不保存 Delegation Child Branch Transcript；thinking 和 streaming 标记也不进入持久记录。

Session 通过 `compaction` 子结构保存 Phase、摘要节点和 Checkpoint。Checkpoint 记录可恢复 Frontier 及其来源 revision、策略版本和摘要 Schema 版本；Final Node 与 Active Phase Checkpoint 均可持久化。该状态来自 canonical transcript，不替代原始消息。Root Branch 中启用 Context Compaction 的 Agent 可以触发 `phase_transition`；成功完成后关闭当前 Phase，并让下一个 Turn 创建新的 Active Phase。

## revision 与 lease

每次提交必须持有目标 Session 的 lease，提供当前 expected revision，并写入恰好递增一的 next revision。File Store 使用 `lease.json` 表示写入所有权并定期更新 heartbeat；已经证明本机持有进程终止的 lease 可以清理，无法确认的锁保持保护状态。

每个 revision 写入独立 JSON 快照，提交使用临时文件与重命名。常规维护保留当前和前一 revision。Clear 通过 `clear.intent` 和专用提交路径确保清空完成后删除较早 Transcript 快照，同时保留必要的维护警告。

## 恢复与选择

`--continue` 只在当前项目中选择最近更新且健康为 ready 的 Session。`--resume` 与 `/resume` 可以跨项目按完整 ID、唯一 ID 前缀或精确名称选择；歧义和不存在都显式失败。恢复时先取得目标 lease，再替换当前 Session，并修复中断 Turn。Agent Group、Active Agent 或 Model Override 无法解析时，Session 保持可查看状态并阻止新 Turn。

恢复后的 Workspace 来自 Session Record，而不是启动命令所在目录。目录不存在时 Session 仍可列出，但不能运行新 Turn。

## 重命名、Model、Mode、Clear 与删除

这些状态操作要求当前没有冲突的 active Turn。重命名只改变名称并递增 revision。Model 切换更新同一 Session 的指定 Agent Override，Mode 切换更新 `activeExecutionMode`，两者均不创建新 Session；运行中的 Turn 保持启动时冻结的 Model、Capabilities 和 Mode。

Clear 保留 Session ID、名称、Workspace、Agent Group、Active Agent、Model Overrides 和 Turn 记录，只清空 Transcript，并同步清空 Compaction 派生状态；仍处于 running 的 Turn 被标记为 interrupted。删除是永久磁盘操作，需要明确确认；删除当前记录后 Controller 创建新的草稿。非交互命令也通过 Selector、Lease 和 Revision 保护相同行为。

## 稳定约束

- `autryn` 每次创建新草稿，不隐式恢复最近 Session。
- Session 保存 Group 与 Agent 状态，Turn 保存冻结的 Group Revision 和本次实际使用的多个 Model。
- Handoff 更新 root Branch 的 Active Agent；下一 Turn 由 Agent Registry 根据同一 Group 与 Overrides 重建。
- 同一 Session 同时只有一个写者，任何无 Revision 校验的覆盖都不合法。
- API Key、Client、AbortController、流、审批回调和 Child Transcript 不进入 Session。
- Compaction 状态只保存摘要节点和 Phase 进度，完整对话仍以 root Transcript 为准。
- Global 与 Project Memory 独立于 Session；Clear 与 Delete 不修改 Memory Document。

存储位置见[配置与存储](../interfaces/configuration-and-storage.md)，Model 时机见[Model 选择](model-selection.md)。
