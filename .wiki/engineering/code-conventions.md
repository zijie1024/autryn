---
title: 代码约定
summary: 说明 Autryn 的语言基线、命名与导入、类型边界、Tool 实现和异步代码约束。
sources:
  - tsconfig.json
  - eslint.config.js
  - .prettierrc
  - src/
  - tests/
related:
  - engineering/repository-layout.md
  - engineering/testing.md
  - workflows/tool-execution.md
  - interfaces/public-api.md
---

# 代码约定

Autryn 的代码约定由可执行配置、公共契约和领域内一致模式共同定义。TypeScript、ESLint 与 Prettier 提供可自动检查的基础，目标模块及其测试证明具体写法；约定用于保持边界清晰，不要求把不同领域机械改写成同一种形式。

## 语言与模块

源码使用严格 TypeScript、ESM 和 Bun，TypeScript 采用 bundler module resolution，并启用未检查索引访问与 override 检查。类型专用依赖使用 `import type`。ESLint 将内置与第三方、`@/*` 内部路径、父级与同级相对路径分组，组间留空并在组内按名称排序。

文件和目录使用 kebab-case，类型与 React 组件使用 PascalCase，函数和变量使用 camelCase。维护中的源码使用命名导出；公共能力只通过明确的模块入口和 Package Export 暴露。Barrel 表达公共或模块组合边界，不要求每个内部目录都创建 `index.ts`。

## 类型与协议

系统边界使用明确类型与 Zod Schema 校验输入。内部字段使用 camelCase；`tool_use`、`tool_result`、`tool_use_id` 等 wire discriminator 保持协议规定的 snake_case；结构化错误码使用稳定的大写下划线形式。公共构造、类型和 wire name 属于兼容性边界，调整时同步检查实现、测试、Export 和示例。

函数、类和 private 成员遵循所在领域的现有模式，不以统一前缀或单一构造参数形式覆盖已经成立的公共契约。注释与 JSDoc 解释意图、不变量和非显然限制，不复述代码或记录修改过程。

## Tool 与异步代码

Coding Tool 通过 `defineTool` 组合名称、描述、Zod 参数和异步调用。面向 Model 的 Tool name 使用稳定 snake_case；可预期结果使用结构化成功或失败，路径参数在执行边界验证。具有副作用的 Tool 同时遵守审批、持久授权、路径范围和取消规则，完整链路见 [Tool 执行流程](../workflows/tool-execution.md)。

流式、并发、timeout 和取消逻辑同时处理成功、失败与清理路径，并把 AbortSignal 传递到实际调用边界。Tool 展示由 ANSI 与 Ink 两条 Renderer 共同提供，新增摘要时优先维护共享结构化摘要，避免两套视图产生不同语义。

## 验证

测试位于根 `tests/` 并按源码领域组织。行为变化优先验证公共结果、状态转换、Schema、错误边界和资源清理；完整分层与质量门见[测试](testing.md)。格式与静态规则以当前配置和 `bun run check` 的结果为准。
