import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createCodingAgent } from "@/coding/agents/lead-agent";
import { Model, type ModelProviderInvokeParams } from "@/core";
import { AgentRuntime } from "@/runtime";

import { createScriptedProvider, finalTextMessage, finalToolUseMessage } from "../../runtime/fake-provider";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "autryn-coding-delegates-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function run(agent: Awaited<ReturnType<typeof createCodingAgent>>) {
  const execution = agent.execute({ role: "user", content: [{ type: "text", text: "go" }] });
  for await (const _event of execution.events) {
    // 排空事件流
  }
  return execution.result;
}

describe("Coding delegated agents", () => {
  test("root Coding Agent can delegate to read-only explore through the common runtime", async () => {
    const ids = ["root", "explore"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const provider = createScriptedProvider([
      (_index, params) => {
        const delegateTool = params.tools?.find((tool) => tool.name === "delegate_task");
        expect(delegateTool).toBeDefined();
        return [
          finalToolUseMessage([{ id: "d", name: "delegate_task", input: { agent: "explore", task: "map files" } }]),
        ];
      },
      (_index, params) => {
        expect(params.tools?.map((tool) => tool.name)).toEqual([
          "file_info",
          "list_files",
          "glob_search",
          "grep_search",
          "read_file",
        ]);
        return [finalTextMessage("explore summary")];
      },
      (_index, params: ModelProviderInvokeParams) => {
        const result = params.messages.at(-1)?.content[0];
        expect(result?.type === "tool_result" ? JSON.parse(result.content) : null).toMatchObject({
          ok: true,
          data: { executionId: "explore", status: "completed" },
        });
        return [finalTextMessage("root done")];
      },
    ]);

    const agent = await createCodingAgent({
      model: new Model("m", provider.provider),
      cwd: tempDir,
      skillsDirs: [],
      runtime,
      askUser: async () => "allow_once",
    });

    await expect(run(agent)).resolves.toMatchObject({ status: "completed", output: { text: "root done" } });
    expect(runtime.getTree("root")?.executions.map((execution) => [execution.id, execution.delegateName])).toEqual([
      ["root", undefined],
      ["explore", "explore"],
    ]);
  });

  test("general delegate may delegate to explore but not to another general", async () => {
    const ids = ["root", "general", "explore"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const provider = createScriptedProvider([
      () => [
        finalToolUseMessage([{ id: "root-d", name: "delegate_task", input: { agent: "general", task: "implement" } }]),
      ],
      (_index, params) => {
        expect(params.tools?.some((tool) => tool.name === "delegate_task")).toBe(true);
        return [
          finalToolUseMessage([
            { id: "general-d", name: "delegate_task", input: { agent: "explore", task: "inspect" } },
          ]),
        ];
      },
      () => [finalTextMessage("explore done")],
      () => [finalTextMessage("general done")],
      (_index, params) => {
        const result = params.messages.at(-1)?.content[0];
        expect(result?.type === "tool_result" ? JSON.parse(result.content) : null).toMatchObject({
          ok: true,
          data: { executionId: "general", status: "completed" },
        });
        return [finalTextMessage("root done")];
      },
    ]);

    const agent = await createCodingAgent({
      model: new Model("m", provider.provider),
      cwd: tempDir,
      skillsDirs: [],
      runtime,
      askUser: async () => "allow_once",
    });

    await expect(run(agent)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getTree("root")?.executions.map((execution) => [execution.id, execution.delegateName])).toEqual([
      ["root", undefined],
      ["general", "general"],
      ["explore", "explore"],
    ]);
  });

  test("general delegate cannot delegate to another general", async () => {
    const ids = ["root", "general"];
    const runtime = new AgentRuntime({ idFactory: () => ids.shift()!, now: () => 100 });
    const provider = createScriptedProvider([
      () => [
        finalToolUseMessage([{ id: "root-d", name: "delegate_task", input: { agent: "general", task: "implement" } }]),
      ],
      () => [
        finalToolUseMessage([{ id: "general-d", name: "delegate_task", input: { agent: "general", task: "again" } }]),
      ],
      (_index, params) => {
        const result = params.messages.at(-1)?.content[0];
        expect(result?.type === "tool_result" ? JSON.parse(result.content) : null).toMatchObject({
          ok: false,
          code: "DELEGATE_NOT_FOUND",
        });
        return [finalTextMessage("general recovered")];
      },
      () => [finalTextMessage("root done")],
    ]);

    const agent = await createCodingAgent({
      model: new Model("m", provider.provider),
      cwd: tempDir,
      skillsDirs: [],
      runtime,
      askUser: async () => "allow_once",
    });

    await expect(run(agent)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getTree("root")?.executions.map((execution) => [execution.id, execution.delegateName])).toEqual([
      ["root", undefined],
      ["general", "general"],
    ]);
  });
});
