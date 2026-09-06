---
title: Skill 与项目指导
summary: 描述 Skill 的搜索顺序、去重、显式调用和 Project AGENTS.md 注入 Coding Agent Context 的过程。
sources:
  - src/runtime/skills/
  - src/coding/agents/delegated-agents.ts
  - src/coding/agents/lead-agent.ts
  - src/terminal/index.tsx
  - src/terminal/session/agent-registry.ts
  - src/terminal/tui/command-registry.ts
  - tests/runtime/skills.test.ts
related:
  - architecture/runtime.md
  - architecture/coding.md
  - architecture/terminal.md
  - workflows/delegation.md
---

# Skill 与项目指导

Autryn 通过 Skill 与工作目录根部的 `AGENTS.md` 为 Coding Agent 提供项目知识和专用工作流。两者进入 Agent Context 的方式不同：Project Guidance 作为专用 Prompt 区段加载，Skill 清单与显式选择由 Middleware 加入 system prompt。

## Skill 搜索

Terminal Agent Registry 按以下优先级构造 Skill 目录：

1. `<session-cwd>/.agents/skills`
2. `<AUTRYN_HOME>/skills`

每个 Skill 是包含 `SKILL.md` 的目录，Frontmatter 提供名称、描述和文件路径。Library 使用者也可以直接传入自定义目录，不依赖 Terminal 的默认路径。

目录按给定优先级处理，目录内文件夹先按名称确定性排序。同名 Skill 以不区分大小写的名称比较，先发现者生效。该规则同时支撑 TUI 的 Skill Slash Command Registry，避免展示与 Runtime 解析使用不同 Skill。

## 注入与显式调用

Skills Middleware 在 `beforeAgentRun` 发现 Skill，并把元数据写入 Agent Context。在 `beforeModel` 中，它把 Skill 名称、描述和 `SKILL.md` 路径加入 system prompt，要求 Agent 在任务匹配时先读取 Skill 文件，再按需读取其引用资源。

TUI 把可用 Skill 注册为 Slash Command。用户以 `/skill-name` 提交时，Command Registry 保留原始请求文本并标记 `requestedSkillName`；SessionController 将该名称设置到当前 Agent。Middleware 在 prompt 中加入显式调用指令，Turn 结束后清除选择，避免影响下一次请求。

Skill 内容采用渐进加载：初始 Context 只包含元数据与路径，不把所有 Skill 正文预先注入 Model。精确工作流由 Agent 使用文件 Tool 读取。

## Project Guidance

创建 Coding Agent 或 delegate 时，Agent Registry 检查工作目录根部的 `AGENTS.md`。存在时，文件全文包装为 `<project_guidance>` 区段并放入该 Agent 的 Prompt；缺失时不添加区段。

Project Guidance 属于当前工作目录，不从 Autryn 源码仓库或父目录递归寻找。恢复 Session 后使用 Session 记录的 cwd，因此加载对应项目的指导。Session 只持久化实际 Turn 消息；每次 Agent 创建时重新加载当前 `AGENTS.md`，使项目规则保持来自文件事实。

## Delegation 策略

Skill 不自动继承给 child。delegate policy 可以选择 none、显式 Skill 集或从 parent 继承，并可按名称 allow。Coding Agent 的 `explore` 不使用 Skill；`general` 继承 parent Skill，并单独注册 Skills Middleware。Project Guidance 由各 delegate factory 显式加载，不依赖 transcript 继承。

## 稳定约束

- Skill 同名冲突始终按目录优先级 first-wins，比较不区分大小写。
- Skill 元数据可以进入 prompt，正文按需读取，不进行全量预加载。
- 显式 Skill 选择只作用于当前 Turn。
- Project Guidance 与 Session transcript 分开维护，当前文件内容在 Agent 创建时生效。
- child 的 Skill 与 Guidance 权限由 delegate configuration 和 policy 明确决定。

Coding Agent 的组合边界见[coding 模块](../architecture/coding.md)，child policy 见[Delegation](delegation.md)。
