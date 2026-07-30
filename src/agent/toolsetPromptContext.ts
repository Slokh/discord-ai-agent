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

export function prepareInitialToolsetPromptContext(input: {
  ctx: ToolContext;
  text: string;
  randomActionAuthorized: boolean;
  activeGame: ActiveGameSessionContext | null;
  activeGameNeedsRandomDraw: boolean;
}) {
  const randomActionRequired = randomActionRequiredForTurn({
    userText: input.text,
    replyContext: input.ctx.replyContext,
    activeGameActionRequested: input.activeGameNeedsRandomDraw,
  });
  let toolsetState = initialToolsetState(
    input.ctx,
    input.text,
    input.randomActionAuthorized,
  );
  if (input.activeGame || randomActionRequired) {
    toolsetState = expandToolsetState(toolsetState, { groups: ["discord-action"] });
  }
  return {
    randomActionRequired,
    toolsetState,
    toolGuidance: scopedToolGuidanceForToolset(currentScopedToolset(input.ctx, toolsetState)),
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
