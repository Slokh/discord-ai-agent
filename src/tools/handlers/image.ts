import { generateImage, getDiscordUserAvatar, inspectDiscordImages } from "../imageTools.js";
import { isOpenRouterHttpError } from "../../models/openrouter.js";
import { cleanToolResponse } from "../responseFormatting.js";
import { stringArgument, stringArrayArgument, numberArgument, booleanArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

// Uniform signatures intentionally expose only the inputs each tool needs.
 
export const imageToolHandlers = {
  "generateImage": async (ctx, route, _originalText) => {
    const prompt = stringArgument(route.arguments, "prompt")!;
    const image = await generateImage(ctx, {
          prompt,
          requiredText: stringArrayArgument(route.arguments, "requiredText"),
          referenceImageUrls: stringArrayArgument(
            route.arguments,
            "referenceImageUrls",
          ),
          useContextImages: booleanArgument(route.arguments, "useContextImages") ?? true,
          outputFormat: stringArgument(route.arguments, "outputFormat") as "png" | "jpeg" | "webp" | undefined,
          background: stringArgument(route.arguments, "background") as "auto" | "transparent" | "opaque" | undefined,
          aspectRatio: stringArgument(route.arguments, "aspectRatio") as "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | undefined,
        });
    return { ...image, content: cleanToolResponse(image.content, ctx.config.maxReplyChars) };
  },
  "inspectDiscordImages": async (ctx, route, _originalText) => {
    try {
      return {
          content: cleanToolResponse(
            await inspectDiscordImages(ctx, {
              question: stringArgument(route.arguments, "question"),
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
    } catch (error) {
      if (
        !isOpenRouterHttpError(error) ||
        error.status !== 400 ||
        !/\bURL did not return an image\b/i.test(error.message)
      ) {
        throw error;
      }
      await ctx.repo.auditTool({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "inspectDiscordImages",
        argumentsSummary: "Scoped image inspection request",
        error: "image_source_unreadable",
      });
      return {
        content: cleanToolResponse(
          "The supplied URL did not resolve to an image. If it is a public webpage, use web_fetch or web_search to inspect the page instead.",
          ctx.config.maxReplyChars,
        ),
        status: "error" as const,
        errorCode: "image_source_unreadable",
      };
    }
  },
  "getDiscordUserAvatar": async (ctx, route, _originalText) => {
    return {
          content: cleanToolResponse(
            await getDiscordUserAvatar(ctx, {
              query: stringArgument(route.arguments, "query")!,
              limit: numberArgument(route.arguments, "limit"),
            }),
            ctx.config.maxReplyChars,
          ),
        };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;
 
