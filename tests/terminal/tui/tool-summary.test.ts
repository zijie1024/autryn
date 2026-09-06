import { describe, expect, test } from "bun:test";

import type { ToolUseContent } from "@/core";
import { toolUseSummary } from "@/terminal/tui/tool-summary";

function toolUse(name: string, input: Record<string, unknown>): ToolUseContent {
  return { type: "tool_use", id: "call_1", name, input };
}

describe("toolUseSummary", () => {
  test("maps shell to description + command", () => {
    expect(toolUseSummary(toolUse("shell", { description: "list files", command: "ls -la" }))).toEqual({
      title: "list files",
      detail: "ls -la",
    });
  });

  test("maps path-based tools to description + path", () => {
    for (const name of ["read_file", "write_file", "str_replace", "list_files", "file_info", "mkdir"]) {
      expect(toolUseSummary(toolUse(name, { description: "inspect", path: "/a/b" }))).toEqual({
        title: "inspect",
        detail: "/a/b",
      });
    }
  });

  test("maps search tools to description + path :: pattern", () => {
    expect(toolUseSummary(toolUse("grep_search", { description: "find", path: "/src", pattern: "TODO" }))).toEqual({
      title: "find",
      detail: "/src :: TODO",
    });
  });

  test("maps move_path to from -> to", () => {
    expect(toolUseSummary(toolUse("move_path", { description: "rename", from: "/a", to: "/b" }))).toEqual({
      title: "rename",
      detail: "/a -> /b",
    });
  });

  test("maps apply_patch to a stable detail", () => {
    expect(toolUseSummary(toolUse("apply_patch", { description: "patch" }))).toEqual({
      title: "patch",
      detail: "unified diff patch",
    });
  });

  test("maps ask_user_question to a count title with the first header as detail", () => {
    expect(
      toolUseSummary(toolUse("ask_user_question", { questions: [{ header: "Auth" }, { header: "Library" }] })),
    ).toEqual({
      title: "Ask user: 2 question(s)",
      detail: "Auth",
    });
  });

  test("maps delegate_task to target agent and task", () => {
    expect(toolUseSummary(toolUse("delegate_task", { agent: "explore", task: "Find the API boundary" }))).toEqual({
      title: "Delegate to explore",
      detail: "Find the API boundary",
    });
  });

  test("returns null for todo_write (special-cased by renderers)", () => {
    expect(toolUseSummary(toolUse("todo_write", { todos: [] }))).toBeNull();
  });

  test("falls back to the tool name for unknown tools", () => {
    expect(toolUseSummary(toolUse("mystery_tool", {}))).toEqual({
      title: "Tool call",
      detail: "mystery_tool",
    });
  });
});
