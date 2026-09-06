# Autryn Wiki

Autryn 是一个基于 Bun 与 TypeScript 的本地 AI Agent Runtime。它以统一的 Model、Message 和 Tool 抽象为基础，提供 Agent Execution、Middleware、Delegation、Handoff、dry-run、Global/Project Memory、持久化 Session、OpenAI 与 Anthropic Provider、Code Agent，以及 CLI/TUI 组合层。本 Wiki 解释这些能力如何组织和协作；精确行为以页面 `sources` 指向的源码、测试与配置为准。

## 使用方式

- 第一次了解项目时，按“推荐阅读顺序”建立从定位到运行流程的整体模型。
- 开发前，从下方目录定位目标模块或 Workflow，再沿页面链接补足上下文。
- 查询精确、易变或高风险事实时，回到目标页面的 `sources` 验证。
- 维护 Wiki 时，先阅读 [Wiki 维护协议](SCHEMA.md)，按 Refresh 和 Lint 规则原地更新当前事实。

## 推荐阅读顺序

1. [项目定位](overview/project.md)：理解 Autryn 解决的问题和系统边界。
2. [能力地图](overview/capability-map.md)：理解主要能力及其连接关系。
3. [系统架构](architecture/system.md)：理解七个模块和依赖方向。
4. [Agent 执行流程](workflows/agent-execution.md)：理解一次请求如何运行。
5. [Tool 执行流程](workflows/tool-execution.md)：理解 Tool 校验、审批、执行与结果回注。
6. [Delegation](workflows/delegation.md)与 [Handoff](workflows/handoff.md)：理解并行委派与串行接管。
7. [dry-run](workflows/dry-run.md)：理解副作用预演和 Execution Tree 报告。
8. [Session 生命周期](workflows/session-lifecycle.md)：理解对话如何创建、保存与恢复。
9. [Context 压缩](workflows/context-compaction.md)与 [Memory](architecture/memory.md)：理解有界输入和跨 Session 长期知识。
10. [工程布局](engineering/repository-layout.md)：进入具体开发与维护。

## 快速理解项目

- [项目定位](overview/project.md)：项目角色、主要使用方式、设计目标与边界。
- [能力地图](overview/capability-map.md)：Agent Loop、Code Agent、Provider、Session、Memory、Delegation、Handoff、dry-run、CLI 与 TUI 的关系。
- [术语](overview/terminology.md)：Autryn 中核心术语的准确含义。

## 理解整体架构

- [系统架构](architecture/system.md)：七个模块、允许的依赖方向、Library 与 CLI 组合路径。
- [core](architecture/core.md)：统一 Model、Message 与 Tool 基础抽象。
- [runtime](architecture/runtime.md)：Agent Loop、Execution、Middleware、Delegation 与资源控制。
- [sessions](architecture/sessions.md)：Session 领域模型、Store、revision 与 lease。
- [Memory](architecture/memory.md)：Global/Project Memory、Adapter、Policy、文件存储与按需召回。
- [providers](architecture/providers.md)：OpenAI 和 Anthropic 协议适配。
- [coding](architecture/coding.md)：Code Agent、开发 Tool、项目指导与审批。
- [terminal](architecture/terminal.md)：CLI、TUI、配置、设置与 Session 组合层。

## 理解关键运行流程

- [Agent 执行流程](workflows/agent-execution.md)：从用户输入到 Execution Result 的主流程。
- [Tool 执行流程](workflows/tool-execution.md)：Tool 发现、参数校验、审批、调用、规范化和渲染。
- [Delegation](workflows/delegation.md)：delegate 注册、child execution、调度、隔离与取消传播。
- [Handoff](workflows/handoff.md)：同一 Execution Branch 内的 Agent 接管与跨 Turn 连续性。
- [dry-run](workflows/dry-run.md)：Tool Effect、Preview 路由与 Execution Tree 报告。
- [Session 生命周期](workflows/session-lifecycle.md)：草稿、物化、Turn、revision、lease、恢复、清空和删除。
- [Context 压缩](workflows/context-compaction.md)：预算、摘要图、frontier、Phase 转换与 Session compaction 状态。
- [Model 选择](workflows/model-selection.md)：Model Catalog、Agent Group 绑定、有效模型与切换语义。
- [Skill 与项目指导](workflows/skills-and-guidance.md)：Skill 搜索、冲突处理、显式调用和 `AGENTS.md` 注入。

## 查询外部接口

- [Public API](interfaces/public-api.md)：Root Export、Subpath Export 与发布入口同步要求。
- [CLI 与 TUI](interfaces/cli-and-tui.md)：启动模式、非交互 Command、Slash Command 与工作目录语义。
- [配置与存储](interfaces/configuration-and-storage.md)：`AUTRYN_HOME`、模型配置、Settings、Session、Memory 和输入历史。

## 进入开发与维护

- [仓库布局](engineering/repository-layout.md)：根目录、源码、测试、脚本、Skill、入口与生成产物。
- [代码约定](engineering/code-conventions.md)：语言基线、命名与导入、类型边界、Tool 和异步代码约束。
- [测试](engineering/testing.md)：测试布局、分层策略、隔离要求与质量门。
- [构建与发布](engineering/build-and-release.md)：Library、平台二进制、npm 启动器和 Release 资产。
- [安全与权限](engineering/security-and-permissions.md)：Tool Approval、Allow List、路径、密钥与进程边界。
- [文档职责](engineering/documentation-ownership.md)：README、Agent 指南、Wiki、注释、测试和 Git 的职责划分。

## 常见问题

| 问题                                    | 页面                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 七个模块如何依赖？                      | [系统架构](architecture/system.md)                                                                    |
| 一次 Agent 请求经历什么？               | [Agent 执行流程](workflows/agent-execution.md)                                                        |
| Tool 为什么会请求审批？                 | [Tool 执行流程](workflows/tool-execution.md) 与 [安全与权限](engineering/security-and-permissions.md) |
| child Agent 获得哪些能力？              | [Delegation](workflows/delegation.md)                                                                 |
| Agent 如何把任务交给另一个 Agent 接管？ | [Handoff](workflows/handoff.md)                                                                       |
| 如何预演 Tool 修改而不提交副作用？      | [dry-run](workflows/dry-run.md)                                                                       |
| 新启动是否恢复旧对话？                  | [Session 生命周期](workflows/session-lifecycle.md)                                                    |
| 长对话如何控制模型输入？                | [Context 压缩](workflows/context-compaction.md)                                                       |
| 长期知识如何跨 Session 保存？           | [Memory](architecture/memory.md)                                                                      |
| 切换 Model 是否创建新 Session？         | [Model 选择](workflows/model-selection.md)                                                            |
| 配置和 Session 保存在哪里？             | [配置与存储](interfaces/configuration-and-storage.md)                                                 |
| Skill 从哪些位置加载？                  | [Skill 与项目指导](workflows/skills-and-guidance.md)                                                  |
| Library 可以从哪些入口导入？            | [Public API](interfaces/public-api.md)                                                                |
| 编写代码时遵循哪些约定？                | [代码约定](engineering/code-conventions.md)                                                           |
| 修改后需要运行哪些检查？                | [测试](engineering/testing.md) 与 [构建与发布](engineering/build-and-release.md)                      |
