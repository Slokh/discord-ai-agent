import { summarizeForAudit } from "../util/text.js";
import type { ToolContext } from "./types.js";
import { renderToolList } from "./registry.js";
import { scopedToolset } from "./toolScope.js";

export async function listTools(ctx: ToolContext): Promise<string> {
  const toolset = scopedToolset({
    config: ctx.config,
    groups: new Set(["core", "discord-retrieval", "image", "spotify", "codegen", "ops", "external"]),
  });
  const content = renderToolList({ localTools: toolset.localTools, serverTools: toolset.serverTools });
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "listTools",
    argumentsSummary: "list tools",
    resultSummary: summarizeForAudit(content)
  });
  return content;
}
