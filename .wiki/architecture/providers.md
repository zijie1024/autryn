---
title: providers 模块
summary: 说明 OpenAI 与 Anthropic Provider 如何适配统一 Model、Message、Tool 和流式响应契约。
sources:
  - src/providers/openai/
  - src/providers/anthropic/
  - tests/providers/
  - src/terminal/provider-options.ts
related:
  - architecture/core.md
  - workflows/agent-execution.md
  - workflows/model-selection.md
  - interfaces/configuration-and-storage.md
---

# providers 模块

`providers` 包含 Autryn 内置的模型服务适配器。每个 Provider 实现 `core` 的 `ModelProvider`，负责将统一 Message、Tool、调用参数、流式事件和 Token Usage 转换为具体服务的协议，而不改变 Runtime 的执行模型。

## OpenAI Provider

OpenAI 适配器使用 OpenAI SDK 的 Chat Completions API。system 与 user 内容保持对应消息；Assistant 的 thinking 映射为兼容 reasoning 字段，Tool Use 映射为 function tool call，Tool Result 映射为独立 tool message。Zod Tool Schema 通过 JSON Schema 暴露给 API。

完整调用解析单个 Assistant Message。流式调用使用 accumulator 按文本、reasoning 和 tool call index 累积快照；完成 Usage 到达后形成最终快照。Model options 在默认参数之后合并，因此调用方可以使用兼容服务支持的扩展参数。

## Anthropic Provider

Anthropic 适配器使用 Anthropic SDK 的 Messages API。system 内容作为顶层 system 参数；Tool Result 以 user role 的 `tool_result` 内容块承载；thinking signature 在多轮对话中原样保留。Tool Schema 转换为 Anthropic input schema。

流式 accumulator 按内容块 index 维护 text、thinking 和 Tool Use，处理 block delta 与最终 Usage。启用 thinking 时，适配器在缺少预算值的情况下从最大输出预算构造 Provider 需要的参数，同时不修改长生命周期的 Model options 对象。

## 配置关系

终端配置提供四类入口：`Anthropic (Official)`、`OpenAI (Official)`、`Anthropic-compatible (Custom)` 和 `OpenAI-compatible (Custom)`。Official 使用固定服务端点；Custom 要求完整的 HTTP(S) Base URL。配置最终仍映射为 `anthropic` 或 `openai` Provider 类型，协议兼容服务复用相应适配器。

两种适配器都把 Runtime 传入的 AbortSignal 交给 SDK 请求，并把服务报告的 Usage 统一为 prompt、completion 与 total Token。流式快照保持累积语义，最终快照与完整调用返回值采用相同 Message 结构。

转换层对调用方保持确定且可测试。

## 依赖与边界

- Provider 依赖 `core` 和各自 SDK，不依赖 `runtime`、`sessions`、`coding` 或 `terminal`。
- Runtime 只通过 Model 和 ModelProvider 契约调用服务，不识别 SDK 类型。
- Provider 拥有协议转换、流式累积和服务默认参数，不拥有 Session、重试策略、Tool Approval 或 TUI 渲染。
- API Key 由终端配置解析后传入 Provider，适配器不负责持久化凭据。
- 普通调用与流式调用最终产生同一统一 Assistant Message 语义；转换测试不连接真实外部 API。

Model 的选择与构造见[Model 选择](../workflows/model-selection.md)，基础消息契约见[core 模块](core.md)。
