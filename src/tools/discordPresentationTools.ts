import type { AgentResponse, ToolContext } from "./types.js";
import { parseDiscordPresentation } from "../discord/components/validation.js";
import { ensureAgentTurnOutput } from "./turnOutput.js";

export async function composeDiscordResponse(ctx: ToolContext, input: unknown): Promise<AgentResponse> {
  const presentation = parseDiscordPresentation(input);
  ensureAgentTurnOutput(ctx).setPresentation(presentation);
  return {
    content: [
      `Registered a Discord Components V2 presentation with ${presentation.components.length} top-level component${presentation.components.length === 1 ? "" : "s"}.`,
      "Now write the concise final response text. It will be rendered above the requested components.",
    ].join(" "),
  };
}
