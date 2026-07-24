import { generateImage, getDiscordUserAvatar, inspectDiscordImages } from "../../tools/imageTools.js";
import { cleanResponse } from "../../tools/responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument, booleanArgument } from "./arguments.js";
import type { ToolName } from "../../tools/registry.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
 
export const imageToolHandlers = {
  "generateImage": async (ctx, route, originalText) => {
    const prompt = stringArgument(route.arguments, "prompt") ?? originalText;
    const image = await generateImage(ctx, {
          prompt,
          requiredText: stringArrayArgument(route.arguments, "requiredText"),
          referenceImageUrls: stringArrayArgument(
            route.arguments,
            "referenceImageUrls",
          ),
          useContextImages: booleanArgument(route.arguments, "useContextImages"),
          outputFormat: stringArgument(route.arguments, "outputFormat") as "png" | "jpeg" | "webp" | undefined,
          background: stringArgument(route.arguments, "background") as "auto" | "transparent" | "opaque" | undefined,
        });
    return {
          content: cleanResponse(image.content, ctx.config.maxReplyChars),
          files: image.files,
          status: image.status,
        };
  },
  "inspectDiscordImages": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await inspectDiscordImages(ctx, {
              question: stringArgument(route.arguments, "question") ?? originalText,
              imageUrls: stringArrayArgument(route.arguments, "imageUrls"),
              messageIdOrUrl: stringArgument(route.arguments, "messageIdOrUrl"),
              useContextImages: booleanArgument(
                route.arguments,
                "useContextImages",
              ),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
  "getDiscordUserAvatar": async (ctx, route, originalText) => {
    return {
          content: cleanResponse(
            await getDiscordUserAvatar(ctx, {
              query: stringArgument(route.arguments, "query") ?? originalText,
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
 
