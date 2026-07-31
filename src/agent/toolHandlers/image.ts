import { generateImage, getDiscordUserAvatar, inspectDiscordImages } from "../../tools/imageTools.js";
import { isOpenRouterHttpError } from "../../models/openrouter.js";
import { hasExplicitImageGenerationIntent } from "../imageGenerationGuard.js";
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
          aspectRatio: stringArgument(route.arguments, "aspectRatio") as "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | undefined,
        });
    return {
          content: cleanResponse(image.content, ctx.config.maxReplyChars),
          files: image.files,
          status: image.status,
        };
  },
  "inspectDiscordImages": async (ctx, route, originalText) => {
    try {
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
          outcome: {
            kind: "grounded_answer",
            state: "succeeded",
            terminal: !hasExplicitImageGenerationIntent(ctx, originalText),
          },
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
        content: cleanResponse(
          "The supplied URL did not resolve to an image. If it is a public webpage, use web_fetch or web_search to inspect the page instead.",
          ctx.config.maxReplyChars,
        ),
        status: "error" as const,
        errorCode: "image_source_unreadable",
      };
    }
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
 
