import type { Logger } from "pino";
import { isOpenRouterTimeoutError, type ChatMessage } from "../models/openrouter.js";
import type { AgentFile, AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs } from "../util/logger.js";
import { synthesizeFinalAnswerWithoutTools } from "./finalSynthesis.js";
import type { ModelCallBudget } from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";

export async function synthesizeToolEvidenceAfterTimeout(
  ctx: ToolContext,
  input: {
    error: unknown;
    round: number;
    roundStartedAt: number;
    text: string;
    messages: ChatMessage[];
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    modelCallBudget: ModelCallBudget;
  },
): Promise<AgentResponse | null> {
  const fallbackModel = ctx.config.openRouter?.utilityModel?.trim();
  if (!isOpenRouterTimeoutError(input.error) || !fallbackModel || fallbackModel === ctx.config.openRouter?.chatModel) return null;
  await recordAgentEvent(ctx, {
    spanId: `agent.model.round.${input.round}`,
    name: `LLM round ${input.round}`,
    status: "failed",
    startedAt: new Date(input.roundStartedAt),
    completedAt: new Date(),
    durationMs: durationMs(input.roundStartedAt),
    metadata: { error: input.error.message, fallbackModel, fallbackMode: "tool_evidence_synthesis" },
  });
  await recordAgentEvent(ctx, {
    eventName: "agent.model.timeout_synthesis_fallback",
    level: "warn",
    summary: `Synthesizing gathered tool evidence with ${fallbackModel}`,
    metadata: { round: input.round, fallbackModel, memoryEventCount: input.memoryEvents.length },
  });
  return await synthesizeFinalAnswerWithoutTools(ctx, {
    reason: "primary model timed out after gathering tool evidence",
    text: input.text,
    messages: input.messages,
    files: input.files,
    memoryEvents: input.memoryEvents,
    requestLogger: input.requestLogger,
    startedAt: input.startedAt,
    modelCallBudget: input.modelCallBudget,
    maxTokens: 2048,
    model: fallbackModel,
  });
}

export function compactMessagesForModelFallback(messages: ChatMessage[], maxCharacters = 24_000): ChatMessage[] {
  const messageCharacters = (message: ChatMessage) => JSON.stringify(message).length;
  const totalCharacters = messages.reduce((total, message) => total + messageCharacters(message), 0);
  if (totalCharacters <= maxCharacters) return messages;

  const keep = new Set<number>();
  let used = 0;
  const keepIndex = (index: number) => {
    if (keep.has(index)) return;
    keep.add(index);
    used += messageCharacters(messages[index]!);
  };

  if (messages.length > 0) keepIndex(0);
  for (let index = 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "system") keepIndex(index);
  }
  if (messages.length > 1) keepIndex(messages.length - 1);

  for (let index = messages.length - 2; index > 0; index -= 1) {
    if (keep.has(index)) continue;
    const size = messageCharacters(messages[index]!);
    if (used + size > maxCharacters) continue;
    keepIndex(index);
  }
  return messages.filter((_message, index) => keep.has(index));
}
