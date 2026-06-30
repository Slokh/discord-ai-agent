import { Client, type Message } from "discord.js";
import type { AgentCodegenJobRecord, DiscordAiAgentRepository } from "../db/repositories.js";
import { cleanResponse } from "../tools/coreTools.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { runWithTrace } from "../util/trace.js";

const CODEGEN_RENDER_POLL_MS = 2_000;
const CODEGEN_RENDER_LIMIT = 20;
const CODEGEN_NONTERMINAL_RENDER_THROTTLE_MS = 5_000;

export type CodegenDiscordRenderer = {
  start: () => void;
  stop: () => void;
};

export function createCodegenDiscordRenderer(input: {
  client: Client;
  repo: DiscordAiAgentRepository;
  maxReplyChars: number;
}): CodegenDiscordRenderer {
  let interval: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    const startedAt = Date.now();
    try {
      const jobs = await input.repo.listRenderableAgentCodegenJobs(CODEGEN_RENDER_LIMIT);
      if (jobs.length > 0) {
        logger.debug({ jobCount: jobs.length }, "Rendering agent codegen Discord updates");
      }
      for (const job of jobs) {
        await renderCodegenJob(input, job);
      }
    } catch (error) {
      logger.warn({ err: error, durationMs: durationMs(startedAt) }, "Agent codegen Discord renderer tick failed");
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (interval) return;
      stopped = false;
      void tick();
      interval = setInterval(() => void tick(), CODEGEN_RENDER_POLL_MS);
      interval.unref?.();
      logger.info("Agent codegen Discord renderer started");
    },
    stop: () => {
      stopped = true;
      if (interval) clearInterval(interval);
      interval = undefined;
      logger.info("Agent codegen Discord renderer stopped");
    }
  };
}

async function renderCodegenJob(
  input: {
    client: Client;
    repo: DiscordAiAgentRepository;
    maxReplyChars: number;
  },
  job: AgentCodegenJobRecord
) {
  await runWithTrace(
    {
      traceId: job.traceId ?? job.requestId,
      requestId: job.requestId,
      guildId: job.guildId ?? undefined,
      channelId: job.channelId ?? undefined,
      userId: job.userId ?? undefined,
      messageId: job.requestId
    },
    async () => {
      const rendered = renderCodegenJobMessage(job);
      if (!shouldRenderCodegenJob(job, rendered)) return;

      const startedAt = Date.now();
      await input.repo.recordTraceEvent({
        traceId: job.traceId ?? job.requestId,
        requestId: job.requestId,
        guildId: job.guildId,
        channelId: job.channelId,
        userId: job.userId,
        eventName: "codegen.render.started",
        summary: rendered.terminal ? "Rendering terminal codegen result" : "Rendering codegen progress",
        metadata: {
          status: job.status,
          currentStep: job.currentStep,
          replyChannelId: job.replyChannelId,
          replyMessageId: job.replyMessageId
        }
      });

      try {
        const message = await fetchCodegenReply(input.client, job);
        const content = cleanResponse(rendered.content, input.maxReplyChars);
        const edited = await message.edit(content);
        await input.repo.markAgentCodegenRendered({
          requestId: job.requestId,
          signature: rendered.signature,
          terminal: rendered.terminal
        });
        if (rendered.terminal && job.threadKey) {
          await input.repo.appendConversationMessage({
            threadKey: job.threadKey,
            role: "assistant",
            discordMessageId: edited.id,
            authorId: input.client.user?.id ?? null,
            authorDisplayName: input.client.user?.username ?? null,
            content,
            metadata: {
              discordUrl: edited.url,
              codegen: true,
              requestId: job.requestId,
              status: job.status,
              prUrl: job.prUrl,
              draft: job.draft,
              verifyPassed: job.verifyPassed
            }
          });
        }
        await input.repo.recordTraceEvent({
          traceId: job.traceId ?? job.requestId,
          requestId: job.requestId,
          guildId: job.guildId,
          channelId: job.channelId,
          userId: job.userId,
          eventName: rendered.terminal ? "codegen.render.terminal" : "codegen.render.complete",
          summary: previewText(content),
          metadata: {
            status: job.status,
            currentStep: job.currentStep,
            replyMessageId: edited.id,
            terminal: rendered.terminal
          },
          durationMs: durationMs(startedAt)
        });
      } catch (error) {
        logger.warn(
          {
            err: error,
            requestId: job.requestId,
            status: job.status,
            replyChannelId: job.replyChannelId,
            replyMessageId: job.replyMessageId
          },
          "Failed to render agent codegen Discord update"
        );
        await input.repo.recordTraceEvent({
          traceId: job.traceId ?? job.requestId,
          requestId: job.requestId,
          guildId: job.guildId,
          channelId: job.channelId,
          userId: job.userId,
          eventName: "codegen.render.failed",
          level: "warn",
          summary: error instanceof Error ? error.message : String(error),
          metadata: {
            status: job.status,
            currentStep: job.currentStep,
            replyChannelId: job.replyChannelId,
            replyMessageId: job.replyMessageId
          },
          durationMs: durationMs(startedAt)
        });
      }
    }
  );
}

export function renderCodegenJobMessage(job: AgentCodegenJobRecord): { content: string; signature: string; terminal: boolean } {
  const terminal = isTerminalCodegenStatus(job.status);
  const content = terminal ? terminalCodegenMessage(job) : progressCodegenMessage(job);
  return {
    content,
    terminal,
    signature: JSON.stringify({
      status: job.status,
      currentStep: job.currentStep,
      statusMessage: job.statusMessage,
      branchName: job.branchName,
      prUrl: job.prUrl,
      draft: job.draft,
      verifyPassed: job.verifyPassed,
      error: job.error
    })
  };
}

function shouldRenderCodegenJob(job: AgentCodegenJobRecord, rendered: { signature: string; terminal: boolean }) {
  if (!job.replyChannelId || !job.replyMessageId) return false;
  if (job.lastRenderedSignature === rendered.signature) return false;
  if (rendered.terminal) return true;
  if (!job.lastRenderedAt) return true;
  return Date.now() - job.lastRenderedAt.getTime() >= CODEGEN_NONTERMINAL_RENDER_THROTTLE_MS;
}

function progressCodegenMessage(job: AgentCodegenJobRecord) {
  const rawDetail = job.statusMessage?.trim();
  const detail =
    job.status === "queued" || !rawDetail
      ? job.status === "running"
        ? "Working on the code change now."
        : "Preparing the code change."
      : rawDetail;
  return [`${detail}`, "", `Update: \`${job.updateName}\``, `Request ID: \`${job.requestId}\``].join("\n");
}

function terminalCodegenMessage(job: AgentCodegenJobRecord) {
  if (job.status === "succeeded" && job.prUrl) {
    const draftNote = job.draft ? " It opened as a draft because verification did not fully pass." : "";
    return `Done: ${job.prUrl}${draftNote}`;
  }
  if (job.status === "no_changes") {
    return `I tried to make that change, but the codegen run did not produce a code diff, so no PR was opened. Request ID: \`${job.requestId}\`.`;
  }
  return `I tried to make that change, but codegen failed: ${job.error ?? "unknown error"}`;
}

function isTerminalCodegenStatus(status: AgentCodegenJobRecord["status"]) {
  return status === "succeeded" || status === "failed" || status === "no_changes";
}

async function fetchCodegenReply(client: Client, job: AgentCodegenJobRecord): Promise<Message> {
  if (!job.replyChannelId || !job.replyMessageId) {
    throw new Error("Codegen job is missing Discord reply target.");
  }
  const channel = await client.channels.fetch(job.replyChannelId);
  const messages = (channel as any)?.messages;
  if (!messages?.fetch) {
    throw new Error(`Discord channel ${job.replyChannelId} does not support message fetch.`);
  }
  return (await messages.fetch(job.replyMessageId)) as Message;
}
