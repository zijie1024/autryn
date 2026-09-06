---
title: 安全与权限
summary: 说明 Tool Approval、dry-run、Memory、路径验证、API Key、Session 数据和外部命令执行的安全边界。
sources:
  - src/coding/permissions/
  - src/coding/tools/
  - src/terminal/settings/
  - src/terminal/config/
  - src/sessions/
  - src/memory/
  - src/runtime/tools/
  - tests/coding/permissions/
related:
  - workflows/tool-execution.md
  - workflows/delegation.md
  - interfaces/configuration-and-storage.md
  - architecture/coding.md
  - workflows/dry-run.md
  - architecture/memory.md
---

# 安全与权限

Autryn 把 Tool 副作用、Preview、文件路径、项目授权、Memory、敏感配置和持久化数据视为不同安全边界。Runtime 提供统一调用、Effect 路由与取消语义，Coding 模块定义 Approval Policy，Terminal 提供用户交互和项目本地授权存储。

## Tool Approval

Code Agent 在 Agent Factory 完成能力组合后，根据最终 Tool Set 的 Effect 为全部 mutation Tool 建立 Approval 边界。该范围覆盖命令执行、文件修改、路径操作、`memory_write` 和调用方注入的 mutation Tool；read、ephemeral、interaction 与 control Tool 不进入 Approval。Approval Middleware 在 Tool 参数通过 Schema 校验后、execute 调用前运行。

Turn 开始时加载当前工作目录的 Allow List 并冻结为 Approval State。未授权 Tool 进入 Approval Manager 队列，并携带 Execution Snapshot 和 AbortSignal。用户可以本次允许、项目始终允许或拒绝；取消或队列溢出采用拒绝语义。拒绝返回结构化 `TOOL_USE_DENIED`，Model 能够选择替代路径或请求澄清。项目级永久授权会更新后续 Turn 使用的 Allow List，不改变当前 Turn 的其他配置。

“项目始终允许”通过抽象 Persistence 写入 `<project>/.autryn/settings.local.json`。Settings Loader 将用户、项目和本地项目层的 `permissions.allow` 取并集。授权按 Tool wire name 表达，不包含任意命令文本或文件路径通配规则。

## dry-run

dry-run 依据 Tool Effect 继续执行 read、ephemeral、interaction 和 control，让 mutation Tool 进入 Preview，并阻止 unknown Effect。Approval Middleware 在该模式下跳过，不读取或写入 Allow List。Preview 不创建目标资源、临时文件、Lock、子进程或外部草稿，并在进入 Model Context、Event 和 Session 前接受序列化、大小和敏感内容校验。

## Delegation 权限

child 不自动继承 parent Tool、Skill、Middleware 或 delegate。Runtime Delegate policy 显式选择空集合、固定集合或受 allow/deny 限制的继承；Terminal Agent Group 的 Delegate Edge 再与目标 Profile 的 Tool 和两层 Memory Policy 求交，只能维持或收紧目标能力。Coding `general` delegate 获得 mutation Tool 时同时配置 Approval Middleware；`explore` 只有只读 Tool。Model 不能通过 `delegate_task` 参数扩大 child 权限。

parent 取消会终止 descendant 和待处理审批。Execution timeout、并发与深度限制防止 child 无界占用 Runtime 资源。

## 路径与文件

Coding Tool 的路径参数要求允许的绝对路径，并通过共享 helper 拒绝无效输入。Session ID 必须是 canonical UUID，Session Path helper 验证解析结果仍位于 Session 根目录。跨平台路径使用 `node:path` 与 Home helper，不拼接固定盘符或单一分隔符。

Shell Tool 以 Session 工作目录作为 cwd，并接收 Execution AbortSignal。Tool Approval 是执行前边界，不把 Shell 当成可信纯函数；调用方仍应根据任务范围控制命令、工作目录和可用 Tool 集。

## 凭据与持久化

API Key 存在模型配置中，创建 Provider 时传入 SDK Client。模型列表和 UI 使用脱敏描述，配置解析错误只显示字段路径，Session 错误写入前清理常见凭据形式。日志、测试 fixture、文档示例和 Tool Result 不使用真实密钥。

Session 只保存可序列化的 root transcript、Model 配置引用与非敏感 Turn 快照。API Key、Provider Client、AbortController、流、审批回调和 child transcript 不进入持久化 Schema。输入历史与 Session 分离，但仍包含用户文本，应按本地敏感数据保护。

Global/Project Memory 接受 Markdown 文本，在写入前拒绝常见凭据模式和不允许的控制字符。File Store 验证 Scope Metadata、Reference、根目录边界、符号链接和大小写折叠冲突；Mutation 使用 expected digest 与 Scope Lock 防止静默覆盖。Memory 属于可审查的本地持久数据，用户可以通过 CLI 查看路径和内容。

## 稳定约束

- 最终 Tool Set 中的 mutation Tool 在 execute mode 下必须拥有有效 Approval Middleware，不能被 Memory、delegate 或 UI 渲染绕过。
- dry-run Mode 由 Execution Tree 持有，Delegation 与 Handoff 无法把它提升为 execute。
- 拒绝和失败保持结构化错误语义，不伪装为成功。
- 持久授权只写入当前项目本地 Settings，用户可以直接审查和撤销。
- 安全检查在实际执行边界完成，prompt 中的建议不能替代路径、Schema、lease 和审批验证。
- Memory Adapter 由 Service 层统一施加 access、digest、内容与容量限制。

完整 Tool 链路见[Tool 执行流程](../workflows/tool-execution.md)，文件位置见[配置与存储](../interfaces/configuration-and-storage.md)。
