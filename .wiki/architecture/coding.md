---
title: coding 模块
summary: 说明 coding 如何在通用 Runtime 上组装 Code Agent、分层 Memory、开发 Tool、Project Guidance、审批和 Delegate。
sources:
  - src/coding/
  - tests/coding/
related:
  - architecture/runtime.md
  - architecture/terminal.md
  - workflows/tool-execution.md
  - workflows/delegation.md
  - architecture/memory.md
  - workflows/dry-run.md
  - workflows/skills-and-guidance.md
---

# coding 模块

`coding` 是建立在 `core`、`runtime` 与 `memory` 上的官方领域实现。它把开发 Tool、Skill、Todo、Project Guidance、Global/Project Memory、Tool Approval、Delegation 和 Handoff 组装为 Code Agent，同时保持终端输入、Session 持久化、Memory 存储和 Provider 配置在模块之外。

## Code Agent 组装

`createCodingAgent` 接收 Model、工作目录、历史消息和可选的 Runtime、Delegate、Handoff、Memory、审批与提问能力。创建时读取工作目录根部的 `AGENTS.md`，把 Project Guidance 放入 Prompt 的专用区段，再接入已有 Session Transcript。

Agent prompt 明确工作目录和 leading/delegate 角色。Skill、Todo、Memory 和可选 Coding Approval Middleware 按顺序注册。Code Tool Set 包括命令执行、文件信息、列表与搜索、目录创建、文件移动、读取、写入、字符串替换和 Patch；Todo Tool 由 Runtime 组合，Memory Tool 由 MemoryIntegration 组合，交互式问题 Tool 只在调用方提供能力时加入。

## Tool 与审批

Code Tool 使用 Zod 描述输入，以绝对路径验证和结构化结果表达可预期失败。每个 Tool 声明 effect，mutation Tool 实现 Preview。Agent 完成 Tool 组合后，从最终 Tool Set 中筛选全部 mutation Tool 并建立 Approval 边界，因此开发 Tool、Memory Tool 和调用方注入的 mutation Tool 使用同一规则。dry-run 不发起 Approval，并由 Runtime 返回 Preview 或 blocked Outcome。

允许“项目始终执行”的决定可以持久化到项目本地 Settings。`coding` 只依赖抽象的 Approval Persistence；具体文件位置和 TUI 队列由 `terminal` 提供。

## Delegate 与 Handoff

直接使用 Coding Factory 的默认组合时，`explore` 只有只读 Tool，不装配 Skill 与 Memory，也不能继续委派；`general` 获得完整开发 Tool、Skill Middleware、Global/Project read-only Memory 和审批，可委派给 `explore`。通过 Agent Group 创建的 Agent 以配置中的 Delegate/Handoff Edge 和目标 Profile 为准。Delegate 使用独立 Child Context；Handoff successor 使用目标 Profile 的完整能力并继续 Root Branch Transcript。

开发 Tool 统一返回面向 Model 可理解的摘要和结构化数据。搜索、文件和命令能力各自保留领域错误码，Runtime 再按 Tool Result policy 控制注入长度；Coding 模块不通过终端文本约定判断成功或失败。

## 模块边界

- `coding` 依赖 `core`、`runtime` 与 `memory`，不依赖 `terminal`、具体 Provider、Session Store 或 Memory Store 实现。
- 开发场景专属 prompt、Tool、审批和 delegate 留在本模块，不进入通用 Runtime。
- React 组件、Slash Command、模型配置和磁盘 Session 不属于 Code Agent。
- `AGENTS.md` 只从当前工作目录加载；缺失时正常创建 Agent。
- Tool 的 Model-facing wire name 保持稳定，路径和副作用在实际调用边界验证。

Tool 的完整调用链见[Tool 执行流程](../workflows/tool-execution.md)，Project Guidance 与 Skill 见[Skill 与项目指导](../workflows/skills-and-guidance.md)。
