import { access, readFile } from "node:fs/promises";

import type { SkillFrontmatter } from "./types";

export async function readSkillFrontMatter(path: string): Promise<SkillFrontmatter> {
  if (!(await pathExists(path))) {
    throw new Error(`File ${path} does not exist`);
  }
  const content = await readFile(path, "utf8");
  return { ...parseFrontMatter(content), path } as SkillFrontmatter;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function parseFrontMatter(content: string): Record<string, string> {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};

  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return {};

  const data: Record<string, string> = {};
  for (const line of normalized.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) data[key] = stripYamlStringQuotes(value);
  }
  return data;
}

function stripYamlStringQuotes(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote === `"` || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1);
  }
  return value;
}
