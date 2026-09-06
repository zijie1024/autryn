// exports-map 冒烟测试。必须在包目录内运行，使裸的 "autryn" 说明符
// 能通过 package.json 的 `exports` 自行解析。
//   bun run scripts/package-exports-smoke.mjs
// 本脚本校验的是已发布的入口（而非源码文件）。

import assert from "node:assert/strict";

const core = await import("autryn/core");
const runtime = await import("autryn/runtime");
const session = await import("autryn/session");
const coding = await import("autryn/coding");
const memory = await import("autryn/memory");
const openai = await import("autryn/providers/openai");
const anthropic = await import("autryn/providers/anthropic");
const root = await import("autryn");

for (const [name, symbol] of [
  ["core.Model", core.Model],
  ["core.defineTool", core.defineTool],
  ["runtime.Agent", runtime.Agent],
  ["runtime.AgentRuntime", runtime.AgentRuntime],
  ["runtime.AgentExecution", runtime.AgentExecution],
  ["runtime.RuntimeContextManager", runtime.RuntimeContextManager],
  ["runtime.ModelContextSummarizer", runtime.ModelContextSummarizer],
  ["runtime.ContextError", runtime.ContextError],
  ["runtime.createDelegateTaskTool", runtime.createDelegateTaskTool],
  ["session.SessionService", session.SessionService],
  ["session.MemorySessionStore", session.MemorySessionStore],
  ["session.resolveSessionSelector", session.resolveSessionSelector],
  ["coding.createCodingAgent", coding.createCodingAgent],
  ["memory.MemoryService", memory.MemoryService],
  ["memory.createMemoryIntegration", memory.createMemoryIntegration],
  ["memory.createFileMemoryAdapter", memory.createFileMemoryAdapter],
  ["memory.FileMemoryStore", memory.FileMemoryStore],
  ["providers/openai.OpenAIModelProvider", openai.OpenAIModelProvider],
  ["providers/anthropic.AnthropicModelProvider", anthropic.AnthropicModelProvider],
]) {
  assert.equal(typeof symbol, "function", `${name} should be a function`);
}
assert.equal(typeof root.Agent, "function", "root export should re-export Agent");
assert.equal(typeof root.AgentRuntime, "function", "root export should re-export AgentRuntime");
assert.equal(typeof root.RuntimeContextManager, "function", "root export should re-export RuntimeContextManager");
assert.equal(typeof root.SessionService, "function", "root export should re-export SessionService");
assert.equal(typeof root.MemoryService, "function", "root export should re-export MemoryService");
assert.equal(typeof memory.DEFAULT_MEMORY_LIMITS, "object", "memory should export DEFAULT_MEMORY_LIMITS");
assert.equal(typeof runtime.DEFAULT_CONTEXT_POLICY, "object", "runtime should export DEFAULT_CONTEXT_POLICY");

console.log("AUTRYN_EXPORTS_SMOKE_OK");
