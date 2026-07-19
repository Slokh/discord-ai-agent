import { listTools } from "../../tools/toolListTools.js";
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
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
/* eslint-enable @typescript-eslint/no-unused-vars */
