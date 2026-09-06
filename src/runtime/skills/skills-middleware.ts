import { join } from "node:path";

import type { AgentMiddleware } from "@/runtime/middleware/agent-middleware";

import { listSkills } from "./list-skills";

/**
 * 从一个或多个 `skillsDirs` 加载 skills，并把 skill 目录注入 model context。
 * 发现、去重与排序都委托给 {@link listSkills}：skills 按 `skillsDirs` 顺序追加，
 * 同名（不区分大小写）时先发现者胜出。
 */
export function createSkillsMiddleware(skillsDirs: string[] = [join(process.cwd(), "skills")]): AgentMiddleware {
  return {
    name: "skills",
    dryRun: { mode: "compatible" },
    beforeAgentRun: async () => {
      const skills = await listSkills(skillsDirs);
      return {
        skills,
      };
    },

    beforeModel: async ({ modelContext, agentContext }) => {
      if (agentContext.skills && agentContext.skills.length > 0) {
        const requestedSkill = agentContext.requestedSkillName
          ? agentContext.skills.find(
              (skill) => skill.name.toLowerCase() === agentContext.requestedSkillName?.toLowerCase(),
            )
          : null;

        const skillsXML = agentContext.skills
          .map((skill) => `<skill name="${skill.name}" path="${skill.path}">\n${skill.description}\n</skill>`)
          .join("\n");

        return {
          prompt:
            modelContext.prompt +
            `\n
<skill_system>
<instructions>
You have access to skills that provide optimized workflows for specific tasks. Each skill contains best practices, frameworks, and references to additional resources.

**Progressive Loading Pattern:**
1. When a user query matches a skill's use case, immediately call \`read_file\` on the skill's main file using the path attribute provided in the skill tag below
2. If an explicit requested skill is provided in the system context, load that skill first even if the user message is short
3. Read and understand the skill's workflow and instructions
4. The skill file contains references to external resources under the same folder
5. Load referenced resources only when needed during execution
6. Follow the skill's instructions precisely
</instructions>

${
  requestedSkill
    ? `<explicit_skill_invocation>
The user explicitly selected the skill "${requestedSkill.name}" from the slash command picker.
You must read the matching skill file at "${requestedSkill.path}" before answering.
</explicit_skill_invocation>
`
    : ""
}

<skills>
${skillsXML}
</skills>
</skill_system>`,
        };
      }
    },
  };
}
