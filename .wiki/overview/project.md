---
title: 项目定位
summary: 说明 Autryn 作为本地 AI Agent Runtime 的角色、主要使用方式、设计目标和系统边界。
sources:
  - package.json
  - src/index.ts
  - src/terminal/index.tsx
  - src/runtime/
  - src/memory/
  - src/coding/
related:
  - overview/capability-map.md
  - architecture/system.md
  - interfaces/public-api.md
---

# 项目定位

Autryn 是可组合、轻量级的本地 AI Agent Runtime。它通过分层架构解耦协议适配、执行编排、Context、Session 与 Memory 管理，使用 Execution 模型承载 Agent Loop、Delegation 与 Handoff，并以 Middleware 支持可插拔扩展。官方 Code Agent 和终端应用展示了这些能力的一种完整组合，Library 使用者也可以只引入所需模块并构建自己的 Agent。

## 主要使用方式

Autryn 提供两条使用路径：

- CLI 路径通过 `autryn` 启动交互式 TUI，组合 Model、Session、Code Agent、Memory、Tool Approval、Skill、Delegation、Handoff 和 dry-run。当前工作目录定义项目、Session 与 Memory Scope。
- Library 路径通过 Root Export 或 Subpath Export 使用 Model、Message、Tool、Agent、Runtime、Session、Memory、Code Agent 和 Provider Adapter。调用方可以组合通用 Runtime，也可以使用官方 Code Agent。

这两条路径共享同一套领域能力。`terminal` 负责装配，不定义另一套 Agent Loop、Session 模型或 Provider 协议。

## 核心设计目标

- 用 Provider 无关的 Model、Message 和 Tool 契约承载不同模型服务。
- 用统一 Agent Runtime 管理 Agent Loop、Execution Branch、Middleware、Tool、Delegation、Handoff 和 dry-run。
- 让 Code Agent 成为 Runtime 上的领域实现，保持基础抽象与开发场景解耦。
- 将 Session 作为明确的持久化领域，保护对话、模型引用和 Turn 结果的一致性。
- 通过 Memory Adapter 保存并按需召回跨 Session 的 Global/Project 长期知识。
- 通过模块边界、结构化结果、取消传播和资源限制保持行为可组合、可测试。
- 同时支持 Windows、macOS 与 Linux，不把用户 Home、路径分隔符或平台二进制写死在领域逻辑中。

## 项目边界

Autryn 内置 OpenAI Chat Completions 与 Anthropic Messages Provider，支持对应协议的自定义兼容端点。它提供本地 Coding Tool、项目 `AGENTS.md` 指导、Skill 发现、终端审批和本地 Session；模型服务本身、远程执行基础设施和外部凭据管理系统不属于 Runtime。

Delegation 在同一 Runtime 内创建 parent-child branch，Handoff 在当前 Branch 内建立 successor Execution；两者共享生命周期、用量、取消和资源限制。Session 持久化 root branch 对话及 active Agent，Memory 独立保存跨 Session 的长期知识，二者都不充当完整 Execution Store。

Autryn 的长期扩展点位于清晰的契约边界：新模型服务实现 Provider，新 Agent 组合 Runtime 能力，新动作实现 Tool，新执行策略接入 Middleware，新委派目标注册 delegate 或 Handoff target，新 Memory 实现接入 Adapter。终端应用是这些能力的一种官方组合方式。

## 知识入口

主要能力关系见[能力地图](capability-map.md)，静态模块结构见[系统架构](../architecture/system.md)，对外 Library 边界见[Public API](../interfaces/public-api.md)。
