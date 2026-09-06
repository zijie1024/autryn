import { describe, expect, test } from "bun:test";

import { appendToolToAllowList, resolveMemorySettings, settingsSchema } from "@/terminal/settings/settings";

describe("settingsSchema", () => {
  test("accepts valid settings with permissions", () => {
    const result = settingsSchema.safeParse({
      permissions: { allow: ["shell", "write_file"] },
    });
    expect(result.success).toBe(true);
  });

  test("accepts empty object", () => {
    const result = settingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("accepts unknown additional fields (passthrough)", () => {
    const result = settingsSchema.safeParse({
      permissions: { allow: ["shell"] },
      someOtherField: "value",
    });
    expect(result.success).toBe(true);
  });

  test("accepts permissions with additional fields (passthrough)", () => {
    const result = settingsSchema.safeParse({
      permissions: { allow: ["shell"], deny: ["dangerous"] },
    });
    expect(result.success).toBe(true);
  });
});

describe("appendToolToAllowList", () => {
  test("adds tool to empty allow list", () => {
    const result = appendToolToAllowList({}, "shell");
    expect(result).toMatchObject({
      permissions: { allow: ["shell"] },
    });
  });

  test("appends tool to existing allow list", () => {
    const result = appendToolToAllowList({ permissions: { allow: ["shell"] } }, "write_file");
    expect(result).toMatchObject({
      permissions: { allow: ["shell", "write_file"] },
    });
  });

  test("does not duplicate tool in allow list", () => {
    const result = appendToolToAllowList({ permissions: { allow: ["shell", "write_file"] } }, "shell");
    expect(result).toMatchObject({
      permissions: { allow: ["shell", "write_file"] },
    });
  });

  test("creates permissions object when it does not exist", () => {
    const result = appendToolToAllowList({ otherKey: "value" }, "shell");
    expect(result).toMatchObject({
      otherKey: "value",
      permissions: { allow: ["shell"] },
    });
  });

  test("handles non-object permissions gracefully", () => {
    const result = appendToolToAllowList({ permissions: "invalid" }, "shell");
    expect(result).toMatchObject({
      permissions: { allow: ["shell"] },
    });
  });

  test("handles array permissions gracefully", () => {
    const result = appendToolToAllowList({ permissions: ["not", "an", "object"] }, "shell");
    expect(result).toMatchObject({
      permissions: { allow: ["shell"] },
    });
  });

  test("filters non-string entries from existing allow list", () => {
    const result = appendToolToAllowList({ permissions: { allow: ["shell", 42, null, "write_file"] } }, "str_replace");
    expect(result).toMatchObject({
      permissions: { allow: ["shell", "write_file", "str_replace"] },
    });
  });

  test("preserves other fields in the document", () => {
    const result = appendToolToAllowList({ theme: "dark", version: 2, permissions: { allow: ["shell"] } }, "write_file");
    expect(result).toMatchObject({
      theme: "dark",
      version: 2,
      permissions: { allow: ["shell", "write_file"] },
    });
  });
});

describe("resolveMemorySettings", () => {
  test("keeps Global and Project settings independent while applying global ceilings", () => {
    const result = resolveMemorySettings([
      { memory: { global: { autoWrite: false }, project: { enabled: false } } },
      { memory: { global: { enabled: false }, project: { autoWrite: false } } },
    ]);
    expect(result).toEqual({
      enabled: true,
      autoWrite: true,
      globalEnabled: false,
      globalAutoWrite: false,
      projectEnabled: false,
      projectAutoWrite: false,
    });
  });

  test("a broad disable cannot be re-enabled by a more specific layer", () => {
    const result = resolveMemorySettings([
      { memory: { enabled: false, autoWrite: false } },
      { memory: { enabled: true, autoWrite: true, global: { enabled: true, autoWrite: true } } },
    ]);
    expect(result.enabled).toBe(false);
    expect(result.autoWrite).toBe(false);
  });
});
