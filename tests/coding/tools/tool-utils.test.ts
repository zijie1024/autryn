import { describe, expect, test } from "bun:test";

import { errorToolResult, okToolResult } from "@/coding/tools/tool-result";
import { truncateText } from "@/coding/tools/tool-utils";

describe("tool-result helpers", () => {
  test("okToolResult returns stable success shape", () => {
    expect(okToolResult("done", { value: 1 })).toEqual({
      ok: true,
      summary: "done",
      data: { value: 1 },
    });
  });

  test("errorToolResult returns stable error shape", () => {
    expect(errorToolResult("failed", "ERR_CODE", { path: "/tmp/x" })).toEqual({
      ok: false,
      summary: "failed",
      error: "failed",
      code: "ERR_CODE",
      details: { path: "/tmp/x" },
    });
  });
});

describe("truncateText", () => {
  test("does not truncate short text", () => {
    expect(truncateText("abc", 10)).toEqual({ text: "abc", truncated: false });
  });

  test("truncates long text with suffix", () => {
    const result = truncateText("abcdef", 3);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("abc");
    expect(result.text).toContain("truncated 3 chars");
  });
});
