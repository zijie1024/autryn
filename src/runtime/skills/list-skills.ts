import type { Dirent } from "node:fs";
import fs, { access } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { readSkillFrontMatter } from "./skill-reader";
import type { SkillFrontmatter } from "./types";

export async function listSkills(skillsDirs: string[] = [join(process.cwd(), "skills")]): Promise<SkillFrontmatter[]> {
  const skills: SkillFrontmatter[] = [];
  const seenSkillFiles = new Set<string>();
  const seenSkillNames = new Set<string>();

  for (let skillsDir of skillsDirs) {
    if (skillsDir.startsWith("~")) {
      skillsDir = join(os.homedir(), skillsDir.slice(1));
    }
    if (!(await pathExists(skillsDir))) continue;

    let folders: Dirent[];
    try {
      folders = await fs.readdir(skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    // 确定性的同名冲突规则（见下）不能依赖 readdir 的返回顺序。
    folders.sort((a, b) => a.name.localeCompare(b.name));

    for (const folder of folders) {
      const skillFilePath = join(skillsDir, folder.name, "SKILL.md");
      if (!folder.isDirectory()) continue;
      if (seenSkillFiles.has(skillFilePath)) continue;
      if (!(await pathExists(skillFilePath))) continue;

      seenSkillFiles.add(skillFilePath);
      const frontmatter = await readSkillFrontMatter(skillFilePath);

      // 同名冲突规则：按 `skillsDirs` 顺序先发现的 skill 胜出（不区分大小写）。
      // 该规则是确定性的，也与 slash-command registry（每名保留首个条目）一致。
      const nameKey = (frontmatter.name ?? "").toLowerCase();
      if (nameKey && seenSkillNames.has(nameKey)) continue;
      if (nameKey) seenSkillNames.add(nameKey);

      skills.push(frontmatter);
    }
  }

  return skills;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
