---
title: Tool 执行流程
summary: 描述 Tool 的发现、Effect 路由、Schema 校验、Middleware、execute 或 Preview、结果回注与终端渲染。
sources:
  - src/core/tools/
  - src/runtime/agent/agent.ts
  - src/runtime/tools/
  - src/runtime/middleware/agent-middleware.ts
  - src/runtime/tool-results/
  - src/coding/tools/
  - src/coding/permissions/
  - src/terminal/tui/tool-summary.ts
related:
  - architecture/core.md
  - architecture/runtime.md
  - architecture/coding.md
  - engineering/code-conventions.md
  - engineering/security-and-permissions.md
  - workflows/dry-run.md
---

# Tool 执行流程

Tool 从 Agent 配置进入 ModelContext，由 Provider 转换为服务 API 可识别的函数定义。模型返回 Tool Use 后，Runtime 在统一边界完成发现、参数校验、Middleware、Effect 路由、execute 或 Preview 和结果规范化，再将 Tool Result 作为 transcript 观察结果交给下一次 Model step。

## 发现与模型调用

Agent 的有效 Tool 由自身 Tool 与 Runtime 动态 Tool 组成。存在 delegate 或 Handoff target 时，Runtime 为当前 Execution 加入对应 control Tool；Code Agent 还包含开发 Tool、Todo Tool、Memory Tool 和可选的 `ask_user_question`。Provider 读取 Tool 名称、描述与 Zod JSON Schema，并转换为 OpenAI function tool 或 Anthropic tool。

Assistant Message 中每个 `tool_use` 提供稳定调用 ID、名称和 JSON 对象输入。Runtime 按名称在本 step 的有效 Tool 中查找；未注册名称形成 Tool 执行错误，并作为观察结果返回 Model。

## 校验与 Middleware

找到 Tool 后，Runtime 对输入执行 Zod `safeParse`。校验通过时，Tool 接收解析后的值；失败时生成 `INVALID_TOOL_INPUT` 结构化错误，Tool 本身不会被调用。该边界确保转换和默认值也由同一 Schema 处理。

参数有效后，Runtime 串行调用 `beforeToolUse` Middleware。Hook 可以继续、变换输入或返回结构化拒绝；变换后的输入再次通过同一 Tool Schema。execute mode 中，Coding Approval Middleware 使用 Turn 开始时冻结的项目 Allow List，未授权时把 Tool Use、Execution Snapshot 与 AbortSignal 交给用户审批队列。拒绝返回结构化 `TOOL_USE_DENIED`，Runtime 将其视为失败观察。

每个 Tool 声明 read、mutation、ephemeral、interaction、control 或 unknown Effect。ToolExecutor 在 execute mode 调用 Tool 实现；在 dry-run 中继续执行安全 Effect，让 mutation 进入 Preview，并以 fail-closed 方式阻止 unknown。Preview 经过结构、大小与敏感内容校验后形成 Tool Outcome。完整路由见[dry-run](dry-run.md)。

## 调用与回注

同一 Assistant Message 中的普通 Tool Use 并行启动；Handoff Tool 必须独占。Runtime 使用完成竞速逐个取得结果，因此较早完成的 Tool Result 先进入 transcript。每个成功 execute 或 Preview 后运行 `afterToolUse`；参数失败、Middleware 跳过、blocked Preview 和异常保持各自的结果语义。

原始返回值通过 Tool Result Runtime 规范化：符合结构化成功或失败契约的值保留摘要、数据、错误码和详情；以 `Error:` 开头的字符串映射为失败；其他值映射为成功。每类 Tool 的 policy 决定注入 Model Context 的数据范围与最大长度，避免文件内容和搜索结果无界增长。

规范化结果序列化为 `tool_result` Content，并通过 `tool_use_id` 关联原调用。Runtime 同时把 Tool Message 写入 Agent context、Execution 消息和事件流。所有调用完成后，本 step 结束，下一次 Model 调用看到这些观察结果。

## Delegation 的等待语义

`delegate_task` 也是 Tool，但等待 child 时可能占用 Delegation Scheduler permit。Runtime 会先等待同一 step 的普通 Tool 完成，再让 nested child parent 暂时释放 permit；child 结束后重新获取 permit 并继续。这使并行普通 Tool 不受 child 等待顺序破坏，并避免嵌套 Delegation 因 permit 被等待者占满而停滞。

## TUI 渲染

终端有 ANSI 文本与 Ink 组件两条渲染路径，两者共享 `toolUseSummary` 生成标题与详情。Tool Result 摘要从结构化 transcript 中提取；Todo 保留专用视图。Renderer 只展示结果，不重新解释审批或执行状态。

## 稳定约束

- Tool 参数只在 Runtime 调用边界统一校验一次，Tool 接收解析后的值。
- Tool Effect 是 Runtime 路由依据；mutation Preview 与 execute 使用相同参数 Schema。
- 可预期失败和审批拒绝使用结构化错误，不通过抛异常或成功字符串表达。
- 支持取消的 Tool 接收当前 Execution 的 AbortSignal。
- Code Tool 的路径输入验证绝对路径和边界；execute mode 下的受控 Tool 需要显式审批或持久授权。
- Model transcript 的内容长度由 policy 控制，UI 摘要不改变模型看到的成功/失败语义。

审批与敏感边界见[安全与权限](../engineering/security-and-permissions.md)。
