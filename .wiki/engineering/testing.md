---
title: 测试
summary: 说明 Autryn 的测试布局、分层策略、Provider 隔离、Session 文件测试、TUI 测试和统一质量门。
sources:
  - tests/
  - package.json
  - tsconfig.json
  - eslint.config.js
related:
  - engineering/repository-layout.md
  - engineering/code-conventions.md
  - engineering/build-and-release.md
  - interfaces/public-api.md
---

# 测试

Autryn 使用 Bun 内置测试运行器，测试集中在根目录 `tests/`，并按 `core`、`runtime`、`sessions`、`providers`、`coding` 和 `terminal` 组织。测试重点保护跨模块契约、状态转换、持久化、安全边界和难以稳定人工验证的行为。

## 布局与命名

测试文件使用 `*.test.ts` 或 `*.test.tsx`，目录按源码领域镜像。例如 Coding Tool 测试位于 `tests/coding/tools/`，Provider 转换测试位于 `tests/providers/<provider>/`。Bun 从工作目录发现测试并跳过隐藏目录，因此质量检查从项目根目录运行。

## 分层策略

- `core` 测试保护 Tool 定义和结构化基础契约。
- `runtime` 测试覆盖 Agent Loop、Middleware、Context 压缩、并行 Tool、取消、Delegation、Scheduler、资源、Skill、Todo 和 Tool Result policy。
- `sessions` 测试覆盖 Schema、Service、compaction 状态、Selector、Memory/File Store、revision、lease、Clear、损坏数据、Provider 消息持久化和路径安全。
- `providers` 测试覆盖消息与 Tool 双向转换、thinking、流式累计和 Usage，不调用真实 API。
- `coding` 测试覆盖开发 Tool 的成功、结构化失败和边界，以及 Approval 和默认 delegate policy。
- `terminal` 测试覆盖配置 Schema、Provider 选项、Model/Session Controller、Settings、Command Registry、输入编辑、历史、Token Usage 与 TUI 可观察输出。

涉及文件系统的测试使用独立临时目录并在结束后清理。真实 API Key、用户路径和外部模型服务不进入测试；Provider 使用结构化 fixture 或 Fake Provider。TUI 优先测试纯函数、Hook 状态和渲染结果，不以组件内部实现作为断言目标。

## 何时增加测试

Bug 修复需要能够在修复前失败的回归测试。纯函数、Schema、Selector、路径计算、状态转换、资源限制和错误分支适合单元测试。薄胶水或显而易见的透传不要求机械增加测试，但公共行为、Session 语义、Tool 副作用、取消和并发变化必须有与风险相称的自动验证。

测试不能通过删除断言、扩大 timeout、跳过失败或调用真实服务来获得表面通过。实现变化导致契约改变时，应同时更新能证明新契约的测试。

## 质量门

`bun run check` 是统一质量门，依次执行 TypeScript `noEmit` 检查、ESLint 和全部 Bun 测试。`bun run check:types` 只验证类型，`bun run lint` 只运行静态规则，`bun test` 适合开发中的定向迭代。

平台二进制、Library Build 和 Package Export 根据变更范围分别执行对应验证，不能由单元测试替代。

## Wiki 检查

Wiki 变更按 [Wiki 维护协议](../SCHEMA.md) 执行确定性与语义 Lint。Markdown 格式通过项目 Prettier 验证；来源、链接、Index 覆盖、孤立页面、禁止结构和内容一致性需要在交付前全量检查。

构建与 Package Export 验证见[构建与发布](build-and-release.md)。
