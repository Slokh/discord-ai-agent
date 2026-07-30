import type { ChatMessage } from "../models/openrouter.js";
import type { ToolContext } from "../tools/types.js";
import { randomActionRequiredForTurn } from "./randomOutcomeGuard.js";
import {
  currentScopedToolset,
  expandToolsetState,
  initialToolsetState,
  type ToolsetState,
} from "./modelToolset.js";
import type { ActiveGameSessionContext } from "./activeGameSession.js";
import { scopedToolGuidance, scopedToolGuidanceForToolset } from "./toolGuidance.js";
import { capabilityIndexForModel } from "../tools/toolScope.js";

export function prepareInitialToolsetPromptContext(input: {
  ctx: ToolContext;
  text: string;
  activeGame: ActiveGameSessionContext | null;
  activeGameNeedsRandomDraw: boolean;
}) {
  const randomActionRequired = randomActionRequiredForTurn({
    userText: input.text,
    replyContext: input.ctx.replyContext,
    activeGameActionRequested: input.activeGameNeedsRandomDraw,
  });
  let toolsetState = initialToolsetState(input.ctx, input.text);
  // An already persisted game is durable state, so its continuation tools are
  // structurally relevant. New-request intent is deliberately left to the
  // model through the capability index rather than a keyword classifier.
  if (input.activeGame) {
    toolsetState = expandToolsetState(toolsetState, { groups: ["discord-action"] });
  }
  return {
    randomActionRequired,
    toolsetState,
    toolGuidance: [
      "On-demand capability groups (call requestAdditionalTools before using one):",
      capabilityIndexForModel(input.ctx.config),
      scopedToolGuidanceForToolset(currentScopedToolset(input.ctx, toolsetState)),
    ].filter((value): value is string => Boolean(value)).join("\n\n"),
  };
}

export function expandToolsetPromptContext(
  state: ToolsetState,
  args: Record<string, unknown> | undefined,
) {
  const previousGroups = new Set(state.groups);
  const toolsetState = expandToolsetState(state, args);
  return {
    toolsetState,
    toolGuidance: scopedToolGuidance(
      [...toolsetState.groups].filter((group) => !previousGroups.has(group)),
    ),
  };
}

export function appendToolRoundContinuation(
  messages: ChatMessage[],
  reminder: string,
  expandedToolGuidance: string | undefined,
) {
  messages.push({
    role: "user",
    content: [
      reminder,
      expandedToolGuidance
        ? `Newly enabled tool guidance:\n${expandedToolGuidance}`
        : null,
    ].filter((content): content is string => Boolean(content)).join("\n\n"),
  });
}
