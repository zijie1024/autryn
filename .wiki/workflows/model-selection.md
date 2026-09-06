---
title: Model 选择
summary: 说明 Model Catalog、Agent Group Binding、Agent 级 Override、Turn Freeze 以及 Handoff 中的多 Model 解析。
sources:
  - src/terminal/config/
  - src/terminal/provider-options.ts
  - src/terminal/session/model-resolver.ts
  - src/terminal/session/agent-registry.ts
  - src/terminal/session/session-controller.ts
  - src/sessions/session-types.ts
  - tests/terminal/session/
related:
  - workflows/session-lifecycle.md
  - workflows/handoff.md
  - architecture/providers.md
  - interfaces/configuration-and-storage.md
  - interfaces/cli-and-tui.md
---

# Model 选择

Autryn 将 Model Connection、Agent Profile 和 Session Override 分层管理。Model Catalog 保存可连接的 Provider 配置，Agent Group 决定每个 Agent 使用哪个 Model，Session Override 只改变当前 Session 对指定 Agent 的选择。

## Model Catalog

每个 Model Entry 具有稳定 UUID、显示名称、实际模型名称、Base URL、API Key、Context Window 和 Provider 类型。Provider 类型只有 `openai` 与 `anthropic`；Official 与 Custom 入口决定 Base URL 的来源和校验方式。

Model Entry 不承担 Agent 身份、Prompt、Tool 或 Memory Policy。它是可被多个 Agent Profile 引用的原子连接配置。

## Agent Group Binding

Agent Group 由 `entryAgentId`、Agent Profiles、Group Defaults 和协作 Edge 组成。Model 解析顺序为：

```text
Session Agent Override
        ↓
Agent Profile modelConfigId
        ↓
Agent Group defaults.modelConfigId
```

每个 Agent 在 Group 解析完成后必须得到有效 Model。Entry Agent 决定新 Session 的起始 Agent；Handoff successor 和 Delegate 使用各自 Profile 的 Model Binding。

`defaultAgentGroupId` 决定新 Session 使用的 Group，Group 的 Entry Agent Binding 决定初始 Model。

## Session 内切换

Session 保存 `agentModelOverrides`，键为 Agent ID，值为 Model Entry ID。`/model` 相关操作如下：

```text
/model
/model <model-selector>
/model <agent-id> <model-selector>
```

`/model <model-selector>` 修改当前 Active Agent；带 Agent ID 的形式修改指定 Agent。两种形式都保留当前 Session、Transcript 和 Agent Group，不创建新 Session。Override 在 Session 物化后以 revision 方式持久化。

运行中的 Turn 不被切换操作修改。切换结果从下一 Turn 的配置解析开始生效。

## Turn Freeze

`SessionController.runTurn` 开始时重新加载有效配置，再由 `AgentRegistry` 根据当前 Group 和 Overrides 生成 Frozen Group。它固定本 Turn 可达的 Agent 图和模型行为信息，包括：

- Group ID 与 Revision；
- 每个 Agent 的 Resolved Model；
- Agent instructions、Capabilities、Delegation 与 Handoff Edge；
- Model Provider、模型名称、Context Window、输出上限和 Context Compaction Mode；
- 可选 Summary Model Binding。

Group Revision 对这些非敏感行为信息计算确定性摘要；Agent Model Override、Model Capability 或 Summary Model Binding 改变都会生成不同 Revision，API Key 轮换不会进入 Revision。Entry Agent、Handoff successor 和 Delegate 都引用这一 Frozen Group。Session 同时在 Turn 创建时固定 Execution Mode，Memory 与 Approval Settings 也在本 Turn 的组合阶段解析；中途变化只影响下一 Turn。

## Handoff 中的 Model

Handoff successor 在同一 Root Branch 中运行，但由目标 Agent Profile 创建新的 Agent Configuration。它使用目标 Agent 的 Model、Prompt、Tool、Middleware 和 Memory Policy，并通过 `effectiveModels` 记录自己的实际 Model。

一个 Turn 可以产生多条 Model Usage，记录范围覆盖 Root、Handoff 与 Delegation Execution：

```text
Execution A · Agent A · Model A
        ↓ Handoff
Execution B · Agent B · Model B
```

Delegation Child 也使用目标 Profile 的 Model，并保持独立 Child Context。父 Session 不保存 Child Transcript；需要诊断实际使用的 Model 时，以 Execution ID 和 Agent ID 关联 Usage。

## Context Window 与 Summary Model

当前 Agent 的 Model Capability 决定本次 Context Budget。Handoff 切换 Model 后，后续 Model 调用按 successor 的 Context Window、Max Output 和安全余量重新计算 Budget；已有 Transcript、Compaction Node 和 Summary 不被重写。

Context Compaction 可以配置独立的 `summaryModelConfigId`。Summary Model 只用于生成摘要，不改变 Active Agent 的 Model Binding，也不改变 Session 的 `/model` Override。

## 恢复与缺失配置

恢复 Session 时，程序校验：

1. Agent Group 是否存在；
2. Active Agent 是否属于该 Group；
3. Agent Profile 和 Group Defaults 是否能解析 Model；
4. 每个 Agent Override 是否指向现有 Model Entry；
5. Workspace、Session Lease 和持久化状态是否可用。

缺失配置被标记为 `agent_missing` 或 `model_missing`，且不会通过 Provider 或名称猜测替代项。相关 Binding 恢复有效后，同一 Session 可以继续 Resume。

## Model 生命周期命令

```text
autryn config model list
autryn config model add
autryn config model remove <model-name>
autryn config model set-default <model-name>
```

删除 Model 前，所有 Agent Group、Agent Profile 和 Context Compaction Summary Model 引用都必须解除。设置默认 Model 修改 Default Agent Group 的 Entry Agent Binding。
