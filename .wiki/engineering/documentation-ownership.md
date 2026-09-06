---
title: 文档职责
summary: 明确 README、Agent 指南、Wiki、代码注释、测试和 Git 历史的知识职责与同步原则。
sources:
  - README.zh.md
  - AGENTS.md
  - AGENTS.zh.md
  - src/
  - tests/
  - .wiki/SCHEMA.md
related:
  - overview/project.md
  - engineering/code-conventions.md
  - engineering/repository-layout.md
  - engineering/testing.md
---

# 文档职责

Autryn 的知识分别服务于使用者、Coding Agent、架构理解、精确实现验证和历史追踪。每类信息选择一个主要所有者，其他位置只提供必要摘要与链接，避免同一事实形成多个独立版本。

## README

README 面向用户和潜在贡献者，负责项目定位、功能概览、安装、首次启动、模型配置、CLI 用法、Session 操作、Library 示例、开发命令和明确的产品边界。跨平台路径和命令在 README 中以用户可执行形式呈现。

Wiki 不复制完整安装步骤、Command 参数表或入门示例。需要理解 CLI 架构和存储模型时，Wiki提供稳定关系；需要执行命令时，以 README 和 CLI `--help` 为准。

## Agent 指南

根 `AGENTS.md` 是 Coding Agent 在仓库中的自动加载规则，负责第一性原理、证据要求、任务范围、实现与验证流程、文档写作、安全边界、禁止事项和交付标准。`AGENTS.zh.md` 是对应的中文版本，用于人工阅读与维护；自动加载仍以名称精确匹配的根 `AGENTS.md` 为准。

Agent 指南保持简短，只规定 Agent 必须如何工作，并链接到所需项目知识。架构、模块职责、Workflow、Public API、代码约定、测试与构建关系由 Wiki 解释；精确写法由项目配置、目标文件和对应测试证明。Agent 修改项目时同时遵守指南并从 Wiki 按需建立系统理解。

## Wiki

`.wiki` 是结构化、相互链接的当前知识层，负责项目概念模型、模块边界、跨模块 Workflow、Public API 结构、配置存储模型与长期工程关系。每个普通页面通过 `sources` 指向主要事实来源。

Wiki 不成为行为事实的最终裁判。遇到精确、易变、高风险或冲突内容时回到源码、测试和配置验证，并按 [Wiki 维护协议](../SCHEMA.md) 原地更新结论。

## 代码注释与工程约定

代码注释解释局部实现中无法直接表达的意图、不变量和协议限制。Public Type 与方法可以使用 JSDoc；注释不承担系统级教程，也不记录修改历史。跨模块且长期稳定的工程规则归入[代码约定](code-conventions.md)，精确且易变的写法由 TypeScript、ESLint、Prettier、目标源码和测试约束。

## 测试

测试是可执行行为证据，保护状态转换、错误分支、协议转换、持久化和公共契约。测试名称与断言说明系统必须做什么；Wiki 综合其意义，但不复制 fixture、完整用例或断言清单。行为变化必须由相应测试证明，而不是仅修改文档结论。

## Git 历史

Git 保存时间线、作者、差异和历史版本。Wiki、README、Agent 指南与代码都只描述当前有效状态，不建立 Archive、Changelog、迁移说明或追加式更新记录来复制 Git 职责。

## 同步规则

| 变化                           | 主要检查位置                                       |
| ------------------------------ | -------------------------------------------------- |
| 安装、用户命令、入门方式       | README、CLI Help                                   |
| Coding Agent 工作规则          | `AGENTS.md` 与相关规范                             |
| 稳定代码约定                   | Wiki 代码约定、工程配置、源码与测试                |
| 模块职责、依赖、跨模块流程     | `.wiki`                                            |
| 精确类型、算法、默认值、Schema | 源码与测试                                         |
| Public API                     | 源码入口、Package Export、README 示例、Wiki 接口页 |
| 历史与迁移原因                 | Git history                                        |

一次变更只更新确实受影响的知识层。实现细节变化且 Wiki 结论不变时，不追加无意义说明；公共行为或架构关系变化时，代码、测试与相应文档在同一任务中保持一致。
