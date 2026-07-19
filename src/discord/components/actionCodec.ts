import {
  discordStoredComponentActionV1Schema,
  type DiscordStoredComponentAction,
} from "./validation.js";

export const CURRENT_DISCORD_ACTION_SCHEMA_VERSION = 1 as const;

export type EncodedDiscordComponentAction = {
  version: typeof CURRENT_DISCORD_ACTION_SCHEMA_VERSION;
  kind: DiscordStoredComponentAction["type"];
  payload: DiscordStoredComponentAction;
};

export function encodeDiscordComponentAction(action: DiscordStoredComponentAction): EncodedDiscordComponentAction {
  const payload = discordStoredComponentActionV1Schema.parse(action);
  return { version: CURRENT_DISCORD_ACTION_SCHEMA_VERSION, kind: payload.type, payload };
}

export function decodeDiscordComponentAction(input: {
  version: unknown;
  kind: unknown;
  payload: unknown;
}): DiscordStoredComponentAction | null {
  if (Number(input.version) !== CURRENT_DISCORD_ACTION_SCHEMA_VERSION) return null;
  const parsed = discordStoredComponentActionV1Schema.safeParse(input.payload);
  if (!parsed.success || parsed.data.type !== input.kind) return null;
  return parsed.data;
}
