---
title: Public API
summary: 说明 Autryn 的 Root Export、Subpath Export、源码入口、发布构建与 Package Export 验证边界。
sources:
  - package.json
  - src/index.ts
  - src/core/index.ts
  - src/runtime/index.ts
  - src/sessions/index.ts
  - src/memory/index.ts
  - src/coding/index.ts
  - src/providers/openai/index.ts
  - src/providers/anthropic/index.ts
  - scripts/package-exports-smoke.mjs
related:
  - architecture/system.md
  - engineering/code-conventions.md
  - engineering/build-and-release.md
  - engineering/testing.md
---

# Public API

Autryn 通过一个 Root Export 和七个领域 Subpath Export 提供 Library 能力。源码入口、JavaScript 构建产物、`package.json#exports` 与 Package Export 冒烟测试共同定义发布边界；内部目录结构本身不自动成为 Public API。

## 导出结构

| 导入路径                     | 源码入口                           | 领域                                              |
| ---------------------------- | ---------------------------------- | ------------------------------------------------- |
| `autryn`                     | `src/index.ts`                     | 聚合 core、runtime、coding、memory 与 sessions    |
| `autryn/core`                | `src/core/index.ts`                | Model、Message、Tool 基础契约                     |
| `autryn/runtime`             | `src/runtime/index.ts`             | Agent、Execution、Handoff、dry-run、Delegation 等 |
| `autryn/session`             | `src/sessions/index.ts`            | Session 模型、compaction 状态、Store、Selector 等 |
| `autryn/coding`              | `src/coding/index.ts`              | Coding Agent、审批与可选交互 Tool                 |
| `autryn/memory`              | `src/memory/index.ts`              | Memory 领域、Adapter、Service、Store 与集成       |
| `autryn/providers/openai`    | `src/providers/openai/index.ts`    | OpenAI Provider                                   |
| `autryn/providers/anthropic` | `src/providers/anthropic/index.ts` | Anthropic Provider                                |

`autryn/package.json` 也作为元数据入口公开。Provider 不由 Root Export 聚合，Library 使用者显式选择服务适配器，避免基础入口隐式绑定具体 SDK 使用路径。

## Root 与 Subpath 的用途

Root Export 适合需要同时组合基础 Runtime、Code Agent、Memory 和 Session 的应用。Subpath Export 让调用方表达依赖意图，并避免从内部源码路径导入。内部 `src/**` 路径、Terminal 组件和 Code Tool 单例不属于发布契约，包消费者不应直接依赖。

源码中只有公共边界或确有聚合需要的目录使用 `index.ts`。barrel 是模块边界，不要求每个内部目录都创建。导出符号的精确清单以相应入口文件为准，Wiki 只维护领域映射。

## 构建与验证

`build:js` 分别构建 CLI JavaScript 入口和八个 Library 入口到 `dist/js`；`build:types` 生成对应的 `dist/types` 声明。两者由 `build:library` 统一执行，输出路径必须与 `package.json#main`、`module`、`types` 和 `exports` 对齐。GitHub Release 的 `.tgz` 包包含启动器、JavaScript 和类型声明。

`scripts/package-exports-smoke.mjs` 使用包自身的裸 specifier 导入全部公开路径，检查关键构造器与函数确实可用。它验证发布映射，而不是直接引用源码。修改 Public API 时，需要在完成 JavaScript 构建后运行该冒烟测试。

## 变更约束

新增、移除、移动或重命名公开能力时必须同步：

1. 所属模块的源码入口。
2. Root Export 是否应聚合该能力。
3. `package.json#exports` 与包元数据。
4. `build:library` 的构建入口和输出路径。
5. Package Export 冒烟测试。
6. 面向使用者的导入示例与版本兼容判断。

Public API 的类型、函数、CLI Command、Slash Command、Tool wire name 和 Session 字段都是不同层次的稳定边界，不因内部文件移动自动更名。构建关系见[构建与发布](../engineering/build-and-release.md)。
