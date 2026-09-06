---
title: core 模块
summary: 说明 core 如何定义 Provider 无关、Runtime 无关的 Model、Message 与 Tool 基础契约。
sources:
  - src/core/
  - tests/core/
related:
  - architecture/system.md
  - architecture/runtime.md
  - architecture/providers.md
  - workflows/tool-execution.md
---

# core 模块

`core` 是 Autryn 的稳定基础层，定义 Model、Message 和 Tool 的共享语言。Runtime、Provider、Session 与 Coding Agent 都围绕这些契约协作，因此该模块保持具体服务、执行策略和用户界面无关。

## 核心职责

Message 使用角色与 Content 判别联合表达完整 transcript。system 只承载文本；user 可以包含文本和图片 URL；assistant 可以包含文本、thinking 与 `tool_use`；tool 通过 `tool_result` 及 `tool_use_id` 关联先前调用。Token Usage 附着在 Assistant Message 上，流式快照通过 `streaming` 表示尚未完成。

`Model` 是模型名称、`ModelProvider` 和可选参数的轻量句柄。调用时，它把 system prompt 与非 system transcript 组织为统一消息序列，将 Tool 和 AbortSignal 一并交给 Provider。`ModelProvider` 同时定义完整调用和累积快照流式调用，使 Runtime 不依赖具体 SDK。

Tool 由名称、面向 Model 的描述、Zod 参数 Schema 和异步 `invoke` 组成。`defineTool` 保留 Schema 与返回类型的推导。结构化 Tool Result 通过 `ok` 区分成功与失败，为 Runtime、Model transcript 和 UI 提供稳定的摘要、数据、错误码与详情语义。

这些类型同时承担 Library 边界与模块间协议。Provider 可以转换它们，Runtime 可以执行它们，调用方也可以直接构造它们；任何一层都不需要使用另一层的内部类或状态容器。

## 公开能力

`src/core/index.ts` 聚合 messages、models 和 tools。`autryn/core` 是对应的发布入口；Root Export 也重新导出这些能力。核心类型和值的精确清单以模块入口为准，Wiki 不复制完整导出表。

## 依赖与协作

`runtime` 使用 Model 调用和 Tool 契约执行 Agent Loop；`providers` 将统一 Message 与 Tool 转换为服务 API；`sessions` 只持久化允许的非 system Message；`coding` 通过 `defineTool` 构建开发动作。所有协作都以 `core` 类型为边界，不要求 `core` 了解调用方。

## 稳定约束

- `core` 不依赖 `runtime`、`sessions`、`providers`、`coding` 或 `terminal`。
- Message content 保持有类型数组，不退化为无结构字符串。
- `tool_use`、`tool_result` 和 `tool_use_id` 是跨 Provider 的 wire discriminator，拼写保持稳定。
- Provider 特有字段和转换逻辑留在 Provider 模块；执行状态、调度和审批不进入 `core`。
- Model 的公开构造和 `ModelProvider` 契约属于 Library 稳定边界，调整时需要同步公开入口与测试。

Agent 如何消费这些契约见[runtime 模块](runtime.md)，服务协议转换见[providers 模块](providers.md)，Tool 的动态流程见[Tool 执行流程](../workflows/tool-execution.md)。
