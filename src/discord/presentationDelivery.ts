import { randomUUID } from "node:crypto";
import type { Message } from "discord.js";
import type { Logger } from "pino";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { AgentFile } from "../tools/types.js";
import type { DiscordPresentation } from "./components/types.js";
import { prepareDiscordPresentation, type PreparedDiscordPresentation } from "./components/renderer.js";
import { DiscordResponseSink, formatDiscordResponseFooter, type DiscordResponseFooter } from "./responseSink.js";

export type DiscordPresentationDeliveryResult = {
  reply: Message;
  preparedPresentation: PreparedDiscordPresentation | null;
  richPresentationDelivered: boolean;
  actionGenerationId: string | null;
};

/** Owns the compile -> pending actions -> Discord write -> activation/fallback transaction boundary. */
export async function deliverDiscordPresentation(input: {
  responseSink: DiscordResponseSink;
  repo: DiscordAiAgentRepository;
  logger: Logger;
  executionId: string;
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  requesterUserId: string;
  content: string;
  files?: AgentFile[];
  footer?: DiscordResponseFooter | null;
  presentation?: DiscordPresentation | null;
  premiumSkuIds?: string[];
}): Promise<DiscordPresentationDeliveryResult> {
  let preparedPresentation = input.presentation
    ? await Promise.resolve().then(() => prepareDiscordPresentation({
        presentation: input.presentation!,
        content: input.content,
        footer: formatDiscordResponseFooter(input.footer),
        fileNames: input.files?.map((file) => file.name),
        premiumSkuIds: input.premiumSkuIds,
      })).catch((error) => {
        input.logger.warn({ err: error }, "Failed to prepare Discord rich presentation; using plain response");
        return null;
      })
    : null;
  let actionGenerationId: string | null = null;
  if (preparedPresentation?.registrations.length) {
    actionGenerationId = randomUUID();
    try {
      await input.repo.createDiscordComponentActionGeneration({
        generationId: actionGenerationId,
        originatingExecutionId: input.executionId,
        guildId: input.guildId,
        channelId: input.channelId,
        sourceMessageId: input.sourceMessageId,
        ownerUserId: input.presentation?.audience === "requester" ? input.requesterUserId : null,
        audience: input.presentation?.audience ?? "requester",
        actions: preparedPresentation.registrations.map(({ token, action, singleUse }) => ({ token, action, singleUse })),
        expiresAt: new Date(Date.now() + (input.presentation?.expiresInMinutes ?? 1_440) * 60_000),
      });
    } catch (error) {
      input.logger.warn({ err: error }, "Failed to persist Discord component action generation; using plain response");
      actionGenerationId = null;
      preparedPresentation = null;
    }
  }
  const finalResult = await input.responseSink.sendFinal({
    content: input.content,
    files: input.files,
    footer: input.footer,
    presentation: preparedPresentation,
  });
  let reply = finalResult.message;
  let richPresentationDelivered = finalResult.usedRichPresentation;
  if (preparedPresentation && richPresentationDelivered && actionGenerationId) {
    try {
      await input.repo.activateDiscordComponentActionGeneration({
        generationId: actionGenerationId,
        responseMessageId: reply.id,
        expectedActionCount: preparedPresentation.registrations.length,
      });
    } catch (error) {
      input.logger.error({ err: error, replyMessageId: reply.id, actionGenerationId }, "Failed to activate delivered Discord component actions");
      await input.repo.cancelDiscordComponentActionGeneration({ generationId: actionGenerationId }).catch(() => undefined);
      reply = await input.responseSink.replaceRichPresentationWithFallback(preparedPresentation) ?? reply;
      richPresentationDelivered = false;
    }
  } else if (actionGenerationId) {
    await input.repo.cancelDiscordComponentActionGeneration({ generationId: actionGenerationId }).catch((error) => {
      input.logger.warn({ err: error, actionGenerationId }, "Failed to cancel undelivered Discord component actions");
    });
  }
  if (!richPresentationDelivered || !actionGenerationId) {
    await input.repo.cancelDiscordComponentActionsForResponseMessage({
      guildId: input.guildId,
      channelId: reply.channelId,
      responseMessageId: reply.id,
    }).catch((error) => input.logger.warn({ err: error, replyMessageId: reply.id }, "Failed to invalidate replaced Discord component actions"));
  }
  return { reply, preparedPresentation, richPresentationDelivered, actionGenerationId };
}
