import { loadSkillContext } from "../../skills/loader.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

export const coreToolHandlers = {
  "loadSkillContext": async (_ctx, route, _originalText) => {
    const name = typeof route.arguments?.name === "string" ? route.arguments.name : "";
    const skill = await loadSkillContext(name);
    return {
      content: skill
        ? `Loaded skill ${skill.name}:\n\n${skill.content}`
        : `No repository skill named ${JSON.stringify(name.trim())} is installed.`,
      status: skill ? "ok" : "error",
      errorCode: skill ? undefined : "skill_not_found",
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
