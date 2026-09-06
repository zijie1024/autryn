---
title: 术语
summary: 定义 Agent、Runtime、Execution、Handoff、dry-run、Memory、Context、Session、Tool、Middleware、Delegation、CLI 与 TUI 在 Autryn 中的含义。
sources:
  - src/core/
  - src/runtime/
  - src/sessions/session-types.ts
  - src/memory/
  - src/coding/
  - src/terminal/
related:
  - overview/project.md
  - overview/capability-map.md
  - architecture/system.md
---

# 术语

本页是 Autryn 核心术语的统一说明。术语按项目中的实际职责定义，不作为中英文词典，也不替代类型和接口的精确声明。

## 基础抽象

- **Model**：由模型名称、`ModelProvider` 和可选调用参数组成的模型句柄。它把统一 `ModelContext` 转换为 Provider 调用参数。
- **Provider**：具体模型服务的适配器，实现完整调用与流式调用，并负责统一 Message、Tool 与服务 API 格式之间的转换。
- **Message**：贯穿 Model、Agent、Provider 和 Session 的统一 transcript 单元，角色包括 system、user、assistant 和 tool；内容由有类型的 Content 组成。
- **Tool**：向 Model 暴露的结构化动作，包含名称、描述、Zod 参数 Schema 和异步调用函数。Tool Use 是模型提出的调用，Tool Result 是执行后的观察结果。

## 运行时概念

- **Agent**：拥有稳定身份、Model、prompt、transcript、Tool、Skill、Middleware，以及可选 Delegate 与 Handoff target 的 ReAct-style 执行主体。
- **Agent Loop**：Agent 在一次运行中重复进行 Model 调用、Tool 发现与执行、结果回注，直到模型不再发出 Tool Use 或运行终止。
- **Runtime**：管理 root 与 child Execution、Delegation、调度、事件、资源限制和 Execution Tree 的通用运行层。
- **Execution**：一次 Agent 运行的生命周期实体。它具有稳定 ID、parent/root 关系、状态、step、用量、事件流、取消信号和最终结果。
- **Execution Branch**：一条连续控制流，由 initial Execution 和零个或多个 Handoff successor 组成。Branch 共享 transcript、Execution Mode、累计用量和 deadline。
- **Step**：Agent Loop 的一次 Model 调用及其后可能发生的一组 Tool 调用。无 Tool Use 的 Assistant 结果结束 Execution。
- **Middleware**：按注册顺序执行的生命周期 Hook，可在 Agent run、step、Model、Tool 与 Handoff 边界观察或调整输入，也可在 Tool 执行前返回结构化拒绝结果。
- **Delegation**：当前 Execution 将自包含任务交给已注册 delegate 的机制。结果是同一 Runtime 中具有 parent execution 的 child Execution，而不是另一套 Runtime。
- **Handoff**：当前 Execution 结束运行并在同一 Execution Branch 中由目标 Agent 建立 successor 的控制权转移。它保持任务连续性，不形成 parent-child 并行关系。
- **Delegate**：带稳定名称、用途说明、Agent 配置工厂和可选 policy 的可委派目标。policy 控制 child 的 Model、Tool、Skill、delegate、step 与 timeout。
- **Execution Tree**：共享 `rootExecutionId` 的 root 与全部 descendant Execution，用于观察状态与聚合用量。
- **Execution Mode**：Execution Tree 的运行模式，取值为 `execute` 或 `dry_run`，由 root 启动时确定并由 Delegation child 与 Handoff successor 继承。
- **Preview**：mutation Tool 在 dry-run 中计算的结构化预演结果，描述计划操作、目标资源、变化状态、警告和可信度，不提交持久副作用。
- **Context**：单次 Model 调用使用的有界输入视图。它由 prompt、Message、Tool 和可选摘要组成，不等同于完整 Session transcript。
- **CompactionNode**：Context 压缩生成的不可变摘要节点，记录来源范围、层级、子节点、摘要文本、估算 Token、策略版本和生成用量。

## 项目知识与交互

- **Memory**：以 Global 或 Project Scope 保存、跨 Session 复用的长期知识，由索引和 Topic Document 组成。
- **Memory Adapter**：组合 Memory Store 与 Retriever 的接入边界，允许 Agent 使用统一语义连接不同 Memory 实现。
- **Skill**：包含 `SKILL.md` 元数据和工作流说明的可发现能力包。Skill Middleware 把可用 Skill 清单和显式选择信息加入 Agent prompt，内容按需加载。
- **Project Guidance**：工作目录根部的 `AGENTS.md`。Coding Agent 创建时将其加载到专用 Prompt 区段，为当前项目提供指导。
- **Code Agent**：构建在通用 Runtime 上的官方领域 Agent，组合开发 Tool、Tool Approval、Skill、Todo、Project Guidance、Memory 和默认 delegate。
- **CLI**：`autryn` 命令及其非交互子命令入口，负责启动、配置和 Session 管理。
- **TUI**：基于 Ink/React 的终端交互界面，负责输入、Slash Command、状态展示、消息渲染和审批交互。

## 持久化概念

- **Session**：面向用户对话的持久化记录，包含工作区身份、Agent Group、active Agent、Agent 级 Model Override、Execution Mode、root transcript、Turn 和 compaction 状态。Session 与 Runtime Execution 的生命周期不同。
- **Session 草稿**：尚未写入磁盘的新 Session。需要保存名称、Model 或 Turn 时才物化为持久记录。
- **Turn**：Session 中一次用户请求及其 root Execution Branch 结果，记录冻结的 Group Revision、实际发生调用的多个有效 Model、Execution Mode、状态、用量、Handoff、dry-run 报告和可公开错误。
- **revision**：Session 每次成功写入后递增的版本序号，用于检测并发写冲突。
- **lease**：File Session Store 的单写者租约，防止多个进程同时覆盖同一 Session。
- **Model 配置**：配置文件中带稳定 ID、显示名称、模型名称、Provider、Base URL 和 API Key 的条目。Session 保存其 ID，而 Turn 保存本次请求实际采用的非敏感快照。

## 关系边界

Session 保存用户与 root Branch 的长期对话；Execution 表示一个 Agent 的一次实际运行；Turn 将 Branch Result 与 Session 关联。Delegation 创建 child branch，Handoff 在当前 branch 中建立 successor，Memory 则独立保存跨 Session 的长期知识。详细关系见[Session 生命周期](../workflows/session-lifecycle.md)、[Delegation](../workflows/delegation.md)、[Handoff](../workflows/handoff.md)和[memory](../architecture/memory.md)。
