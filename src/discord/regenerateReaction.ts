import { PermissionsBitField } from "discord.js";

/**
 * Unicode "counterclockwise arrows" emoji used to request regeneration of a bot reply.
 * Discord delivers this as the emoji name "🔄" with no custom emoji id.
 */
export const REGENERATE_REPLY_REACTION_EMOJI = "\uD83D\uDD04";

/**
 * Unicode emojis that request regeneration of a bot-generated image. Any of these
 * reactions on a bot image message triggers image regeneration for the original
 * prompter. Custom guild emojis are ignored so lookalikes cannot trigger it.
 */
export const IMAGE_REGENERATION_REACTION_EMOJIS: ReadonlySet<string> = new Set([
  "\uD83D\uDD04", // 🔄 counterclockwise arrows
  "\uD83D\uDD01", // 🔁 clockwise arrows
  "\uD83C\uDFB2" // 🎲 game die
]);

/**
 * Tool names that produce a bot-generated image. Replies whose tool audit logs
 * include any of these are treated as image-generation flows for regeneration.
 */
export const IMAGE_GENERATION_TOOL_NAMES: ReadonlySet<string> = new Set(["generateImage"]);

/**
 * Tool names that indicate a bot reply was produced by a coding-agent task
 * rather than a normal conversational response. Replies that used any of these
 * tools must not be regenerated via the 🔄 reaction.
 */
export const CODING_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "runCodingAgent",
  "getAgentTaskStatus",
  "listAgentTasks",
  "retryAgentTask",
  "cancelAgentTask",
  "inspectAgentLogs",
  "getDeploymentStatus"
]);

type ReactionEmojiLike = {
  id?: string | null;
  name?: string | null;
};

/**
 * Returns true when the reaction emoji is the 🔄 counterclockwise arrows used to
 * request reply regeneration. Custom guild emojis are ignored so a custom
 * "counterclockwise arrows" lookalike cannot accidentally trigger regeneration.
 */
export function isRegenerateReplyReaction(emoji: ReactionEmojiLike | null | undefined): boolean {
  if (!emoji) return false;
  if (emoji.id) return false;
  return emoji.name === REGENERATE_REPLY_REACTION_EMOJI;
}

/**
 * Returns true when the reaction emoji is one of the image-regeneration emojis
 * (🔄, 🔁, or 🎲). Custom guild emojis are ignored so lookalikes cannot trigger
 * image regeneration.
 */
export function isImageRegenerationReaction(emoji: ReactionEmojiLike | null | undefined): boolean {
  if (!emoji) return false;
  if (emoji.id) return false;
  return Boolean(emoji.name && IMAGE_REGENERATION_REACTION_EMOJIS.has(emoji.name));
}

/**
 * Returns true when any of the supplied tool names correspond to an image-generation
 * tool. Used to detect bot replies that produced an image so regeneration reactions
 * on them follow the image-regeneration (original-prompter-only) path.
 */
export function involvesImageGenerationTools(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) {
    if (IMAGE_GENERATION_TOOL_NAMES.has(name)) return true;
  }
  return false;
}

/**
 * Returns true when any of the supplied tool names correspond to a coding-agent
 * tool. Used to skip regeneration for replies that involved durable code-update
 * work.
 */
export function involvesCodingAgentTools(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) {
    if (CODING_AGENT_TOOL_NAMES.has(name)) return true;
  }
  return false;
}

type PermissionLike = {
  has: (permission: bigint) => boolean;
};

type RegenerationPermissionInput = {
  reactorId: string | null | undefined;
  originalRequesterId: string | null | undefined;
  memberPermissions?: PermissionLike | null;
};

/**
 * Returns true when the reacting user is allowed to trigger regeneration of a
 * bot reply: the original requester, or a server admin (Manage Messages or
 * Administrator).
 */
export function canTriggerReplyRegeneration(input: RegenerationPermissionInput): boolean {
  if (input.reactorId && input.originalRequesterId && input.reactorId === input.originalRequesterId) {
    return true;
  }
  const permissions = input.memberPermissions;
  if (!permissions?.has) return false;
  return Boolean(
    permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      permissions.has(PermissionsBitField.Flags.Administrator)
  );
}

type ImageRegenerationPermissionInput = {
  reactorId: string | null | undefined;
  originalPrompterId: string | null | undefined;
};

/**
 * Returns true when the reacting user is allowed to trigger regeneration of a
 * bot-generated image. Only the user who originally prompted that image may
 * regenerate it; server admins do not get an override for image regeneration.
 */
export function canTriggerImageRegeneration(input: ImageRegenerationPermissionInput): boolean {
  return Boolean(
    input.reactorId &&
      input.originalPrompterId &&
      input.reactorId === input.originalPrompterId
  );
}
