---
title: Memory
summary: 说明 Global 与 Project 分层 Memory 的领域模型、Adapter 接入、文件存储、按需召回以及与 Session 和 Context 的边界。
sources:
  - src/memory/
  - src/coding/agents/
  - src/terminal/session/memory-runtime.ts
  - src/terminal/commands/memory.ts
  - tests/memory/
related:
  - architecture/system.md
  - architecture/coding.md
  - workflows/context-compaction.md
  - workflows/delegation.md
  - workflows/handoff.md
  - workflows/dry-run.md
  - interfaces/configuration-and-storage.md
---

# Memory

`memory` 是独立的长期知识模块。它以 `Global` 和 `Project` 两个 Scope 分层保存可复用知识：Global 面向同一用户的多个 Workspace，Project 面向当前 Workspace。两层具有独立的文档、权限、Budget、锁和事件标识。

## 领域结构

```text
MemoryScope
├── Global { scopeId: "global" }
└── Project { projectId, projectKey, cwd }
```

Project Scope 由规范化 project key 派生稳定 SHA-256 ID；Global Scope 使用固定 `global` ID。Scope Identity 同时用于 Store、Event、Lock、Tool Result 和 dry-run Resource。展示层可以使用短 ID，持久化和诊断使用完整 ID。

Memory Document 使用 Markdown。`MEMORY.md` 是精简常驻索引，Topic Document 使用小写 kebab-case Reference 保存细节。Index-guided Retriever 在每次 Model 调用前读取当前 Scope 的索引，Agent 根据 Reference 使用 `memory_read` 精确读取 Topic。首版不执行关键词、Embedding 或向量相关度召回。

## Adapter 与 Service

```text
Layered Memory Integration
├── Global Memory Middleware ──→ Global MEMORY.md
├── Project Memory Middleware ──→ Project MEMORY.md
├── memory_read ────────────────→ list or view by Scope
└── memory_write ──────────────→ preview or commit by Scope
        │
        ▼
MemoryService ──→ MemoryAdapter
                  ├── MemoryStore
                  └── MemoryRetriever
```

`MemoryStore` 定义 inspect、list、read 和 commit，`MemoryRetriever` 定义 bootstrap 与 reference retrieval，`MemoryAdapter` 组合两类 Port。Library 可以替换整个 Adapter；Agent、Session 和 Runtime 不依赖 File Store。

`MemoryService` 统一执行 Scope 校验、访问控制、Token Budget、内容安全、expected digest 和调用方 limits。`MemoryIntegration` 接收有序的 Layer 列表，一次为一个 Agent 组合 Global 与 Project；同一 Service 可以服务不同 Agent 的不同 Policy。

## Layered Policy

每层 Policy 包含：

- `access`：`none`、`read` 或 `read_write`；
- `autoWrite`：是否注册 `memory_write`；
- `failureMode`：`required` 或 `best_effort`；
- Bootstrap、文档数量、文档大小和 Scope 总量限制。

默认 Bootstrap Budget 为 Global 600 tokens、Project 1200 tokens、合计 1800 tokens。Runtime 按 Global、Project 顺序组装两段带 Scope 标记的 Prompt；Project 知识具有更具体的适用范围。Runtime 不对两层 Markdown 做语义合并或去重。

一个 Agent 的最终 Policy 取 Settings 与 Agent Profile 的交集。任意上层关闭的 Scope 不能由后层重新开启。未授权 Scope 不进入 Memory Tool Schema；Global 自动写入由 Model 显式调用 `memory_write` 触发，不在 Turn 结束时后台生成。

## 文件实现

```text
<AUTRYN_HOME>/memory/
├── global/
│   ├── scope.json
│   ├── MEMORY.md
│   └── <topic>.md
└── projects/
    └── <project-id>/
        ├── scope.json
        ├── MEMORY.md
        └── <topic>.md
```

Global 与 Project 的同名 Topic 物理独立。`scope.json` 校验 Scope 身份，Document 是权威内容。读路径不创建目录；写路径在 Scope Lock 内重新读取当前状态，使用 expected digest 检测并发修改，并通过临时文件与 rename 原子提交内容。

Store 拒绝路径穿越、非规范 Reference、大小写折叠冲突、Scope 路径或 Document 中的符号链接，以及不匹配的 Metadata。Preview 不创建 Scope Directory、Metadata、Lock 或临时文件。

## Memory Tool

`memory_read` 的 `list` 可以选择 `global`、`project` 或 `all`；`view` 必须显式选择单一 Scope。`memory_write` 的 `scope` 必填，Mutation、expected digest、Preview 和 Commit 始终在选定 Scope 内执行。Result 和 Event 都携带 Scope kind 与稳定 Scope ID，避免同名 Reference 产生歧义。

## Context、Session 与 Agent

Memory Middleware 在每次 Model 调用前读取两个 Scope 的最新 `MEMORY.md`，将固定说明和索引追加到 Prompt，并由 TokenEstimator 计入输入 Budget。Bootstrap 不进入 canonical transcript，也不成为 CompactionNode；`memory_read` 的 Tool Result 按普通历史参与 Context 管理。

Session 保存完整会话与 Turn，Context Compaction 派生当前 Session 的有界输入，Memory 保存跨 Session 的长期知识。Root Code Agent 可以按 Profile 同时读写两层；Delegate 和 Handoff successor 根据自己的 Profile 创建独立 Integration，不隐式继承 predecessor 的 Tool、Middleware、缓存或未提交 Mutation。

`/memory` 按 Global、Project 分组显示状态。CLI 使用显式 Scope：

```text
autryn memory list [--scope global|project|all]
autryn memory show <reference> --scope global|project
autryn memory path --scope global|project
```
