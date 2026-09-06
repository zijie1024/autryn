---
title: 仓库布局
summary: 解释 Autryn 根目录、七个源码模块、测试、脚本、入口文件和生成产物的职责。
sources:
  - package.json
  - index.ts
  - src/
  - tests/
  - scripts/
  - bin/
related:
  - architecture/system.md
  - engineering/code-conventions.md
  - engineering/testing.md
  - engineering/build-and-release.md
  - engineering/documentation-ownership.md
---

# 仓库布局

Autryn 仓库按运行模块、工程支持和生成产物分区。目录结构表达职责边界，但 Wiki 页面按知识问题组织，不逐文件镜像仓库。

## 根目录

```text
autryn/
├── bin/
├── .wiki/
├── scripts/
├── src/
├── tests/
├── index.ts
├── package.json
└── 配置与说明文件
```

根 `index.ts` 只加载 Terminal CLI，是源码运行和二进制编译入口。`package.json` 定义包身份、Command、公开导出、依赖、构建和发布元数据。TypeScript、ESLint、Prettier 与 Markdownlint 配置约束工程质量。

## 源码

`src/` 包含七个模块：

- `core/`：Model、Message 和 Tool 基础契约。
- `runtime/`：Agent Loop、Execution、Middleware、Delegation、Handoff、dry-run、Skill、Todo 和 Tool Result Runtime。
- `sessions/`：Session 领域、Store、revision、lease 与 Selector。
- `memory/`：Global/Project Memory 领域、Adapter、Policy、Service、Retriever 和文件实现。
- `providers/`：OpenAI 与 Anthropic 适配器。
- `coding/`：Code Agent、开发 Tool、Project Guidance、Memory 组合和审批。
- `terminal/`：CLI、TUI、配置、Settings、Session 与 Model 组合。

`src/index.ts` 是 Library Root Export。各公共模块入口承担 Subpath Export；内部目录不因存在 `index.ts` 自动成为包接口。

## 测试

`tests/` 按七个模块组织，并在需要时继续镜像源码子领域。Provider 测试验证转换和流式 accumulator，Session 与 Memory 测试验证持久化和并发保护，Runtime 测试验证 Agent、Delegation、Handoff、dry-run、Skill 和 Tool Result，Terminal 测试验证配置、Controller、TUI 纯逻辑与可观察输出。

测试 helper 留在相关测试域，例如 Runtime 的 Fake Provider 和 TUI Render helper。测试不放入隐藏目录，因为 Bun 默认跳过隐藏目录发现。

## 工程支持

- `scripts/` 负责平台二进制、Package Export 冒烟和 GitHub Release 发布。
- `bin/` 是 npm 全局命令启动器，定位或下载当前平台二进制。
- `.wiki/` 组织架构、Workflow、Interface 和稳定工程知识；代码约定集中在[代码约定](code-conventions.md)。

Wiki 通过 Frontmatter 把页面映射回上述事实来源，不参与 Runtime 构建，也不复制 `src/` 的文件层级。

## 生成与本地状态

`dist/` 是 Library 与二进制构建产物，`node_modules/` 是依赖，缓存目录和项目 `.autryn` 本地覆盖属于运行状态。这些目录不作为手工源码维护目标。发布与构建脚本可以重新生成 `dist`，开发者不通过直接编辑产物修改行为。

依赖方向见[系统架构](../architecture/system.md)，检查与产物关系见[测试](testing.md)和[构建与发布](build-and-release.md)。
