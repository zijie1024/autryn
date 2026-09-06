import type { ToolUseContent } from "@/core";

/**
 * 与渲染器无关的 tool 调用摘要：一个人可读的标题加可选次要详情行。
 * ANSI 渲染器（`message-text.ts`）与 Ink 渲染器（`message-history.tsx`）
 * 都消费它并各自格式化，使 name→summary 的映射只维护在一处。
 *
 * `todo_write` 有意不在此提供（返回 `null`）：两个渲染器都用
 * 更丰富的、感知 todo 快照的内容对它做特殊处理。
 */
export type ToolSummary = {
  title: string;
  detail?: string;
};

export function toolUseSummary(content: ToolUseContent): ToolSummary | null {
  if (content.name === "todo_write") {
    return null;
  }

  const input = content.input as Record<string, unknown>;
  const description = (input.description as string | undefined) ?? "";

  switch (content.name) {
    case "shell":
      return { title: description, detail: (input.command as string | undefined) ?? "" };
    case "str_replace":
    case "read_file":
    case "write_file":
    case "list_files":
    case "file_info":
    case "mkdir":
      return { title: description, detail: (input.path as string | undefined) ?? "" };
    case "glob_search":
    case "grep_search":
      return {
        title: description,
        detail: `${(input.path as string | undefined) ?? ""} :: ${(input.pattern as string | undefined) ?? ""}`,
      };
    case "move_path":
      return {
        title: description,
        detail: `${(input.from as string | undefined) ?? ""} -> ${(input.to as string | undefined) ?? ""}`,
      };
    case "apply_patch":
      return { title: description, detail: "unified diff patch" };
    case "ask_user_question": {
      const questions = (input.questions as Array<{ header?: string }> | undefined) ?? [];
      const count = questions.length;
      const first = questions[0]?.header;
      return {
        title: `Ask user${count ? `: ${count} question(s)` : ""}`,
        ...(first ? { detail: first } : {}),
      };
    }
    case "delegate_task":
      return {
        title: `Delegate to ${(input.agent as string | undefined) ?? "agent"}`,
        detail: (input.task as string | undefined) ?? "",
      };
    default:
      return { title: "Tool call", detail: content.name };
  }
}
