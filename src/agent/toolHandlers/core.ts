import { listTools } from "../../tools/toolListTools.js";
import { loadSkillContext } from "../../skills/loader.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
/* eslint-disable @typescript-eslint/no-unused-vars */
export const coreToolHandlers = {
  "listTools": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(await listTools(ctx), ctx.config.maxReplyChars),
        };
  },
  "loadSkillContext": async (_ctx, route) => {
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
/* eslint-enable @typescript-eslint/no-unused-vars */
