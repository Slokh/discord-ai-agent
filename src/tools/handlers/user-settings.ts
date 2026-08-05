import { setMyTimezone } from "../userTimezoneTools.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const userSettingsToolHandlers = {
  setMyTimezone: async (ctx, route) => setMyTimezone(ctx, {
    action: typeof route.arguments?.action === "string" ? route.arguments.action : undefined,
    timezone: typeof route.arguments?.timezone === "string" ? route.arguments.timezone : undefined,
  }),
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
