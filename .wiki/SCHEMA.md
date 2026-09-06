# Autryn Wiki 维护协议

本文件定义 `.wiki` 的信息架构、页面 Schema 和维护流程。Wiki 面向开发者与 Coding Agent，负责解释 Autryn 的当前架构、运行机制、公共边界和长期工程约束。源码、测试、配置和正式文档始终是行为事实来源；Wiki 是对这些来源进行组织与综合后的知识层。

## 内容边界

Wiki 记录模块职责、依赖方向、生命周期、数据流、控制流、公共边界、安全约束和跨模块关系。安装步骤与完整命令用法归 README，Agent 工作规则归 `AGENTS.md`，精确实现归源码与测试，变更历史归 Git。

Wiki 不保存 Raw Source 副本，不镜像 README 或 Agent 指南，不记录 Changelog、Roadmap、任务进度、迁移说明和开发日志，也不为每个源码文件建立说明页。

## 目录与命名

```text
.wiki/
├── index.md
├── SCHEMA.md
├── overview/
├── architecture/
├── workflows/
├── interfaces/
└── engineering/
```

- `overview/` 建立项目定位、能力地图和术语模型。
- `architecture/` 解释系统静态结构与七个模块的职责边界。
- `workflows/` 解释跨模块的动态运行过程。
- `interfaces/` 记录 Library、CLI、TUI、配置和存储的外部边界。
- `engineering/` 记录仓库布局、代码约定、测试、构建、安全和文档职责。
- 普通页面文件名使用 kebab-case；目录层级保持在两级。
- 不建立 `raw/`、`archive/`、`history/`、`logs/`，也不建立 `log.md`、`changelog.md` 或 `roadmap.md`。

## 普通页面 Schema

每个普通页面以以下 Frontmatter 开始：

```yaml
---
title: 页面标题
summary: 一句话说明页面回答的问题。
sources:
  - src/example/
related:
  - architecture/system.md
---
```

字段约束：

- `title` 必填，必须与正文唯一的一级标题一致。
- `summary` 必填，使用一句话准确概括正文。
- `sources` 必填，使用仓库根目录相对路径，路径必须存在并指向主要事实来源。
- `related` 可选，使用 `.wiki` 根目录相对路径，目标页面必须存在。
- 不设置 `created`、`updated`、`status` 或 `version`；时间线由 Git 维护。

正文直接给出核心结论，再按主题选择“核心模型”“运行流程”“稳定约束”“模块关系”等章节。每页只回答一个明确问题，普通页面以 500 至 1200 个中文字为宜；复杂 Workflow 可以适当增加。没有独立价值的内容合并到相邻主题，不为满足模板保留空章节。

## 写作规范

全部页面遵循以下原则：

> 避免过时阐述，避免纠正式阐述，避免追加式阐述，确保阐述正向、清晰、准确、简练。

- 直接描述当前事实，不以“过去”“原来”“不再”“新增”“修复后”等迁移叙事介绍现状。
- 行为变化时原地重写结论并删除失效内容，不在末尾追加更新记录。
- 不设置“最近变更”“修正说明”“迁移说明”“历史版本”等章节。
- 优先记录稳定关系；完整枚举、默认数值和精确 Signature 留在唯一事实来源中。
- 保留 Agent、Runtime、Execution、Provider、Session、Turn、Tool、Skill、Middleware、Delegation、CLI、TUI 等通用英文术语。
- `overview/terminology.md` 是术语含义的唯一完整说明页。
- 正文只引用理解所需的关键符号与路径，不复制大段源码或完整 TypeScript Signature。

## 来源与链接

- `sources` 只声明支撑页面核心结论的主要来源，不追求完整文件清单。
- 使用标准 Markdown 相对链接，确保 GitHub、编辑器和普通 Markdown Renderer 均可导航。
- 每个普通页面必须由 `index.md` 直接收录，并至少关联一个相邻页面。
- 重要关系应在双方页面中建立链接。
- 同一知识只在一个页面完整解释；其他页面提供短说明并链接到主页面。
- 精确、易变或高风险事实需要回到 `sources` 验证。

## Refresh

公共行为、模块职责、跨模块流程或持久化语义变化时执行 Refresh：

1. 根据修改路径定位 `sources` 覆盖该路径的页面。
2. 阅读事实来源，并核对相邻页面与测试。
3. 原地重写当前结论，删除失效或重复内容。
4. 更新 Frontmatter 中的 `sources`、`related` 和正文链接。
5. 更新 `index.md` 中对应摘要或导航。
6. 执行 Wiki Lint。

仅有实现细节变化且 Wiki 结论保持有效时，不进行无意义更新。Refresh 只产生完整的当前页面，不生成变更附录或时间线。

## Query

使用 Wiki 查询项目知识时：

1. 从 `index.md` 识别领域与推荐入口。
2. 阅读目标页面，并沿 `related` 或正文链接补足必要上下文。
3. 对精确、易变或高风险结论回到 `sources` 验证。
4. 基于 Wiki 与事实来源形成回答。
5. 发现具有长期价值且当前缺失的综合结论时，按本协议更新主页面。

Wiki 用于减少重复推导，不阻止 Agent 按需核对实现。

## Lint

Wiki Lint 同时包含确定性检查和语义检查。

确定性检查：

- 所有 Markdown 内部链接均能解析到现有文件。
- 所有 `sources` 路径和 `related` 页面存在。
- 普通页面具有完整 Frontmatter，标题与一级标题一致。
- `index.md` 收录所有普通页面，且不存在孤立页面。
- 普通页面文件名符合 kebab-case。
- 不存在禁止的目录、页面、日期页面和任务总结页面。

语义检查：

- 页面结论与当前代码、测试和配置一致。
- 页面之间不存在冲突或同一事实的多个完整版本。
- 页面不引用失效的模块名、目录名、命令名或公开入口。
- 正文不包含纠正式、迁移式、追加式叙述。
- 页面没有复制大段源码、README 或 Agent 指令。
- `summary` 能准确概括正文，术语和链接文字保持一致。
- 表达保持正向、清晰、准确、简练。

每次 Refresh 后执行确定性检查，并对受影响页面及其相邻页面执行语义检查。首次全量搭建完成后，对所有页面执行两类检查。

## 开发流程

修改公共行为、模块职责、跨模块流程、公开入口、安全策略或持久化语义时，任务结束前检查 `.wiki`。Wiki 更新与相关实现处于同一次任务或同一 Commit。README、Agent 指南、Wiki、代码注释、测试和 Git 的职责边界以 [文档职责](engineering/documentation-ownership.md) 为准。

## 验收条件

- `index.md` 和本协议存在，目录与页面符合既定信息架构。
- 所有页面从 `index.md` 可达，Frontmatter、来源和链接有效。
- 七个模块及关键 Workflow 与实现一致。
- Session、Model、Delegation、Handoff、dry-run、Memory、Tool Approval 和 Package Export 已由事实来源核对。
- Wiki 只描述当前项目，不包含 Raw、Log、Archive、Roadmap 或迁移叙事。
- 新 Agent 可以从 `index.md` 建立整体认识，并能从页面定位精确事实来源。
