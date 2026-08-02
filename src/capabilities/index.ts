import type { AgentCapabilityRuntime, AgentPromptContribution } from "../agent/capabilityRuntime.js";
import type { ToolContext } from "../tools/types.js";
import { prepareAgentModelCapability } from "./agentModel.js";
import { prepareDiscordEmojiCapability } from "./discordEmoji.js";
import { freshDataPromptContribution } from "./freshData.js";
import { imageContextPromptContribution } from "./imageContext.js";
import { prepareRandomGameCapability } from "./randomGames.js";

/** Installs product capabilities behind the one extension surface consumed by the generic agent loop. */
export async function prepareAgentCapabilities(
  ctx: ToolContext,
  userText: string,
): Promise<AgentCapabilityRuntime> {
  const [modelCapability, emojiContribution, randomGame] = await Promise.all([
    prepareAgentModelCapability(ctx),
    prepareDiscordEmojiCapability(ctx, userText),
    prepareRandomGameCapability(ctx, userText),
  ]);
  const promptContributions: Array<AgentPromptContribution | undefined> = [
    freshDataPromptContribution(),
    modelCapability.promptContribution,
    emojiContribution,
    imageContextPromptContribution(ctx),
    randomGame.promptContribution(),
  ];
  return {
    model: modelCapability.model,
    promptContributions: promptContributions.filter(
      (contribution): contribution is AgentPromptContribution => contribution !== undefined,
    ),
    observeToolResult: (toolName, result) => randomGame.observeToolResult(toolName, result),
    finalizeResponse: (response) => randomGame.finalizeResponse(response),
    blocksTimeoutRecovery: () => randomGame.blocksTimeoutRecovery(),
  };
}
