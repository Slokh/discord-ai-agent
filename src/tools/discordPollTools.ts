import { summarizeForAudit } from "../util/text.js";
import type { AgentResponse, ToolContext } from "./types.js";

export type CreateDiscordPollInput = {
  question: string;
  answers: string[];
  durationHours?: number;
  allowMultiselect?: boolean;
};

export type DiscordPollSendResult = {
  messageId: string;
  channelId: string;
  url: string;
};

const DEFAULT_DURATION_HOURS = 24;
const MAX_DURATION_HOURS = 168;
const MIN_DURATION_HOURS = 1;
const MAX_ANSWERS = 10;
const MIN_ANSWERS = 1;
const MAX_QUESTION_CHARS = 300;
const MAX_ANSWER_CHARS = 55;

export async function createDiscordPoll(
  ctx: ToolContext,
  input: CreateDiscordPollInput
): Promise<AgentResponse> {
  const question = (input.question ?? "").trim();
  const answers = (input.answers ?? [])
    .map((answer) => (typeof answer === "string" ? answer.trim() : ""))
    .filter((answer) => answer.length > 0);

  if (!question) {
    await auditPoll(ctx, input, "missing poll question");
    return pollError("invalid_poll", "I need a poll question to create a Discord poll.");
  }
  if (question.length > MAX_QUESTION_CHARS) {
    await auditPoll(ctx, input, `poll question over ${MAX_QUESTION_CHARS} chars`);
    return pollError("invalid_poll", `Discord caps poll question text at ${MAX_QUESTION_CHARS} characters. Please shorten the question.`);
  }
  if (answers.length < MIN_ANSWERS) {
    await auditPoll(ctx, input, "no poll answers");
    return pollError("invalid_poll", "I need at least one poll answer option to create a Discord poll.");
  }
  if (answers.length > MAX_ANSWERS) {
    await auditPoll(ctx, input, `too many poll answers (${answers.length})`);
    return pollError("invalid_poll", `Discord polls support at most ${MAX_ANSWERS} answer options. You provided ${answers.length}.`);
  }
  const overlongAnswer = answers.find((answer) => answer.length > MAX_ANSWER_CHARS);
  if (overlongAnswer) {
    await auditPoll(ctx, input, `poll answer over ${MAX_ANSWER_CHARS} chars`);
    return pollError("invalid_poll", `Discord caps each poll answer at ${MAX_ANSWER_CHARS} characters. Please shorten: "${truncateForAudit(overlongAnswer, 80)}".`);
  }

  const durationHours = boundedDuration(input.durationHours);
  const allowMultiselect = input.allowMultiselect ?? true;

  if (!ctx.sendDiscordPoll) {
    await auditPoll(ctx, input, "no discord poll sender available", { durationHours, allowMultiselect });
    return pollError("poll_runtime_unavailable", "I cannot post a Discord poll from here because the bot runtime did not wire up native poll sending. Try asking me in a normal Discord channel.");
  }

  let result: DiscordPollSendResult;
  try {
    result = await ctx.sendDiscordPoll({ question, answers, durationHours, allowMultiselect });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditPoll(ctx, input, `poll send failed: ${message}`, { durationHours, allowMultiselect }, true);
    return pollError("poll_send_failed", `I could not post the Discord poll: ${message}`, true);
  }

  await auditPoll(ctx, input, `posted poll message ${result.messageId}`, {
    durationHours,
    allowMultiselect,
    messageId: result.messageId,
    url: result.url
  }).catch(() => undefined);

  return {
    content: formatPollResult({ question, answers, durationHours, allowMultiselect, result }),
    status: "ok",
    outcome: { kind: "discord_poll", state: "succeeded", terminal: true },
  };
}

function pollError(errorCode: string, content: string, retryable = false): AgentResponse {
  return { content, status: "error", errorCode, retryable, outcome: { kind: "discord_poll", state: "failed" } };
}

function boundedDuration(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : DEFAULT_DURATION_HOURS;
  if (!Number.isFinite(parsed)) return DEFAULT_DURATION_HOURS;
  const hours = Math.floor(parsed);
  if (hours < MIN_DURATION_HOURS) return MIN_DURATION_HOURS;
  if (hours > MAX_DURATION_HOURS) return MAX_DURATION_HOURS;
  return hours;
}

function formatPollResult(input: {
  question: string;
  answers: string[];
  durationHours: number;
  allowMultiselect: boolean;
  result: DiscordPollSendResult;
}): string {
  const selection = input.allowMultiselect ? "multiple answers allowed" : "one answer only";
  const answerLines = input.answers.map((answer, index) => `${index + 1}. ${answer}`).join("\n");
  return [
    `Posted a native Discord poll in <#${input.result.channelId}>.`,
    `Question: ${input.question}`,
    `Options:\n${answerLines}`,
    `Duration: ${input.durationHours} hour(s) · ${selection}`,
    input.result.url
  ].join("\n");
}

async function auditPoll(
  ctx: ToolContext,
  input: CreateDiscordPollInput,
  resultSummary: string,
  extra?: Record<string, unknown>,
  isError = false
): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "createDiscordPoll",
    argumentsSummary: summarizeForAudit({
      question: input.question,
      answerCount: (input.answers ?? []).length,
      answers: input.answers,
      durationHours: input.durationHours,
      allowMultiselect: input.allowMultiselect
    }),
    resultSummary: summarizeForAudit(extra ? { result: resultSummary, ...extra } : resultSummary),
    ...(isError ? { error: resultSummary } : {})
  });
}

function truncateForAudit(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
