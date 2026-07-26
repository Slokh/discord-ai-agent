import type { ToolName } from "../tools/registry.js";
import type { AgentResponse } from "../tools/types.js";

export type ArtifactActionTool = "updateBotAvatar" | "createDiscordEmoji";

const AVATAR_ACTION =
  /\b(?:avatar|profile\s+(?:picture|image)|pfp)\b/i;
const AVATAR_TARGET =
  /\b(?:bot|your|yours|you|own|profile)\b/i;
const EMOTE_ACTION =
  /\b(?:custom|server)\s+(?:emoji|emote)s?\b|\bemotes?\b/i;
const MUTATION_ACTION =
  /\b(?:set|use|change|update|make|create|generate|turn|convert|upload|add)\b/i;

export function requestedArtifactActionForPrompt(text: string): ArtifactActionTool | null {
  if (!MUTATION_ACTION.test(text)) return null;
  if (AVATAR_ACTION.test(text) && AVATAR_TARGET.test(text)) return "updateBotAvatar";
  if (EMOTE_ACTION.test(text)) return "createDiscordEmoji";
  return null;
}

export class CompoundToolCompletionGuard {
  private readonly requiredTool: ArtifactActionTool | null;
  private generated = false;
  private forcedAttempts = 0;
  private actionAttempted = false;
  private terminalAction: { routeName: ArtifactActionTool; result: AgentResponse } | null = null;

  constructor(text: string) {
    this.requiredTool = requestedArtifactActionForPrompt(text);
  }

  noteToolResult(routeName: ToolName, result: AgentResponse) {
    if (
      routeName === "generateImage" &&
      result.status !== "error" &&
      (result.files?.length ?? 0) > 0
    ) {
      this.generated = true;
      return;
    }
    if (this.generated && routeName === this.requiredTool) {
      this.actionAttempted = true;
      this.terminalAction = { routeName, result };
    }
  }

  hasPendingAction() {
    return Boolean(
      this.requiredTool &&
      this.generated &&
      !this.actionAttempted,
    );
  }

  takeForcedTool(): ArtifactActionTool | null {
    if (!this.hasPendingAction() || this.forcedAttempts >= 2) return null;
    this.forcedAttempts += 1;
    return this.requiredTool;
  }

  shouldRetryMissingAction() {
    return this.hasPendingAction() && this.forcedAttempts < 2;
  }

  missingActionGuidance() {
    if (!this.requiredTool) return "";
    return `The generated image is ready, but the user's compound request is incomplete. Call ${this.requiredTool} now using the generated image. Do not claim the action succeeded without that tool result.`;
  }

  incompleteActionResponse() {
    if (this.requiredTool === "updateBotAvatar") {
      return "I generated the image, but couldn't update my Discord avatar. The generated image is attached.";
    }
    return "I generated the image, but couldn't create the server emoji. The generated image is attached.";
  }

  completedAction() {
    if (!this.terminalAction || this.terminalAction.result.status === "error") {
      return null;
    }
    return this.terminalAction;
  }

  takeTerminalAction() {
    const terminal = this.terminalAction;
    this.terminalAction = null;
    return terminal;
  }
}
