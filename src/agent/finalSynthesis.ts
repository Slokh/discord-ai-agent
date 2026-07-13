import type { Logger } from "pino";
import type { ChatMessage, ChatResult } from "../models/openrouter.js";
import { toolByName } from "../tools/registry.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type {
  AgentFile,
  AgentResponse,
  AgentTable,
  ToolContext,
} from "../tools/types.js";
import { durationMs, previewText } from "../util/logger.js";
import {
  BEST_EFFORT_RESPONSE_GUIDANCE,
  CONTEXT_DISCIPLINE_GUIDANCE,
  DISCORD_RESPONSE_STYLE_GUIDANCE,
} from "./promptBuilder.js";
import {
  hostedToolMarkupRecoveryResponse,
  isLeakedHostedToolMarkup,
  recoverFromLeakedHostedToolMarkup,
  stripLeakedHostedToolMarkup,
} from "./modelRecovery.js";
import {
  cleanFinalModelResponse,
  reserveModelCall,
  type ModelCallBudget,
} from "./routerShared.js";
import { recordAgentEvent } from "./runtimeTranscript.js";
import { runObservedModelCall } from "./modelCallTelemetry.js";

export function modelCallCeilingFallback(
  ctx: ToolContext,
  input: {
    text: string;
    files: AgentFile[];
    tables?: AgentTable[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
  },
): AgentResponse {
  const content =
    toolEvidenceFallback(input.memoryEvents) ||
    "I hit the model-call safety limit before I could finish that turn. Try again with a narrower request.";
  return {
    content: cleanResponse(content, ctx.config.maxReplyChars),
    files: input.files.length > 0 ? input.files : undefined,
    tables: input.tables && input.tables.length > 0 ? input.tables : undefined,
    memoryEvents:
      input.memoryEvents.length > 0 ? input.memoryEvents : undefined,
  };
}

export async function synthesizeFinalAnswerWithoutTools(
  ctx: ToolContext,
  input: {
    reason: string;
    text: string;
    messages: ChatMessage[];
    files: AgentFile[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    modelCallBudget: ModelCallBudget;
  },
): Promise<AgentResponse> {
  const finalStartedAt = Date.now();
  input.requestLogger.info(
    {
      reason: input.reason,
      messageCount: input.messages.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
    },
    "Agent forced final synthesis",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.final_synthesis.started",
    summary: input.reason,
    metadata: {
      reason: input.reason,
      messageCount: input.messages.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
    },
  });
  if (!(await reserveModelCall(ctx, input.modelCallBudget, "final_synthesis", { reason: input.reason }))) {
    return modelCallCeilingFallback(ctx, input);
  }
  // Deliberately tool-free: forced synthesis happens after the tool loop has
  // ended, and offering hosted tools here is what caused models (z-ai/glm) to
  // emit raw <tool_call> markup into the final user-visible answer.
  const response = await runObservedModelCall(ctx, {
    purpose: "final_synthesis",
    metadata: { reason: input.reason },
    chat: {
      messages: finalSynthesisMessages(input.text, input.memoryEvents),
      temperature: 0.2,
      maxTokens: 4096,
      retryPolicy: "expensive",
    },
  });

  if (response.finishReason === "length") {
    input.requestLogger.warn(
      {
        finishReason: response.finishReason,
        contentChars: response.content.length,
        model: response.model,
      },
      "Final synthesis truncated due to max_tokens limit; response may be incomplete",
    );
  }
  let content = stripLeakedHostedToolMarkup(response.content).trim();
  if (!content && isLeakedHostedToolMarkup(response.content)) {
    const recovery = await hostedToolMarkupRecoveryResponse(ctx, {
      text: input.text,
      messages: finalSynthesisMessages(input.text, input.memoryEvents),
      leakedContent: response.content,
      modelCallBudget: input.modelCallBudget,
    });
    content = recovery.content;
  }
  content =
    content ||
    toolEvidenceFallback(input.memoryEvents) ||
    "I found relevant evidence, but I could not compose a clean answer from it.";
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "chat",
      argumentsSummary: input.text,
      resultSummary: content,
      model: response.model,
      estimatedCostUsd: response.estimatedCostUsd,
    },
  });
  input.requestLogger.info(
    {
      durationMs: durationMs(input.startedAt),
      finalSynthesisDurationMs: durationMs(finalStartedAt),
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
    },
    "Agent request complete",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Final synthesis completed with ${content.length} chars`,
    metadata: {
      reason: input.reason,
      finalChars: content.length,
      fileCount: input.files.length,
      memoryEventCount: input.memoryEvents.length,
    },
    durationMs: durationMs(input.startedAt),
  });
  return {
    content: cleanFinalModelResponse(content),
    files: input.files.length > 0 ? input.files : undefined,
    memoryEvents:
      input.memoryEvents.length > 0 ? input.memoryEvents : undefined,
  };
}

export async function finalizeModelRoundWithoutTools(
  ctx: ToolContext,
  input: {
    round: number;
    roundStartedAt: number;
    text: string;
    messages: ChatMessage[];
    response: ChatResult;
    files: AgentFile[];
    tables: AgentTable[];
    memoryEvents: NonNullable<AgentResponse["memoryEvents"]>;
    requestLogger: Logger;
    startedAt: number;
    modelCallBudget: ModelCallBudget;
    recoveryState: { emptyNoToolRecoveryAttempted: boolean };
  },
): Promise<AgentResponse> {
  const {
    round,
    roundStartedAt,
    text,
    messages,
    response,
    files,
    tables,
    memoryEvents,
    requestLogger,
    startedAt,
    modelCallBudget,
    recoveryState,
  } = input;
  const responseContent = stripLeakedHostedToolMarkup(
    response.content,
  ).trim();
  if (!responseContent && isLeakedHostedToolMarkup(response.content)) {
    return await recoverFromLeakedHostedToolMarkup(ctx, {
      round,
      text,
      messages,
      leakedContent: response.content,
      files,
      memoryEvents,
      requestLogger,
      startedAt,
      model: response.model,
      estimatedCostUsd: response.estimatedCostUsd,
      modelCallBudget,
    });
  }
  if (!responseContent && memoryEvents.length > 0) {
    return await synthesizeFinalAnswerWithoutTools(ctx, {
      reason: "empty model response after tool evidence",
      text,
      messages,
      files,
      memoryEvents,
      requestLogger,
      startedAt,
      modelCallBudget,
    });
  }
  if (!responseContent) {
    if (!recoveryState.emptyNoToolRecoveryAttempted) {
      recoveryState.emptyNoToolRecoveryAttempted = true;
      const requestedToolCalls = response.toolCalls.map(
        (call) => call.name,
      );
      const unsupportedToolCalls = unsupportedToolCallNames(
        response.toolCalls,
      );
      requestLogger.warn(
        {
          round,
          model: response.model,
          finishReason: response.finishReason,
          requestedToolCalls,
          unsupportedToolCalls,
        },
        "Model returned empty response with no usable tool calls; retrying with recovery instruction",
      );
      await recordAgentEvent(ctx, {
        eventName: "agent.empty_response_recovery.started",
        level: "warn",
        summary: "Model returned no answer and no usable tool call",
        metadata: {
          round,
          model: response.model,
          finishReason: response.finishReason,
          requestedToolCalls,
          unsupportedToolCalls,
        },
        durationMs: durationMs(roundStartedAt),
      });
      await recordAgentEvent(ctx, {
        audit: {
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          userId: ctx.userId,
          toolName: "agentError",
          argumentsSummary: text,
          error: "empty_model_response_no_usable_tool",
          model: response.model,
          estimatedCostUsd: response.estimatedCostUsd,
        },
      });
      if (!(await reserveModelCall(ctx, modelCallBudget, "empty_response_recovery", { round }))) {
        return modelCallCeilingFallback(ctx, { text, files, tables, memoryEvents });
      }
      const recovery = await runObservedModelCall(ctx, {
        purpose: "empty_response_recovery",
        metadata: { round },
        chat: {
          messages: emptyNoToolRecoveryMessages(messages),
          temperature: 0.2,
          maxTokens: 1024,
          retryPolicy: "expensive",
        },
      });
      const recoveryContent = stripLeakedHostedToolMarkup(
        recovery.content,
      ).trim();
      if (recoveryContent) {
        await recordAgentEvent(ctx, {
          audit: {
            guildId: ctx.guildId,
            channelId: ctx.channelId,
            userId: ctx.userId,
            toolName: "chat",
            argumentsSummary: text,
            resultSummary: recoveryContent,
            model: recovery.model,
            estimatedCostUsd: recovery.estimatedCostUsd,
          },
        });
        return {
          content: cleanFinalModelResponse(recoveryContent),
          files: files.length > 0 ? files : undefined,
          tables: tables.length > 0 ? tables : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
        };
      }
    }

    const content = emptyNoToolFinalFallback();
    await recordAgentEvent(ctx, {
      audit: {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "chat",
        argumentsSummary: text,
        resultSummary: content,
        model: response.model,
        estimatedCostUsd: response.estimatedCostUsd,
      },
    });

    requestLogger.warn(
      {
        durationMs: durationMs(startedAt),
        model: response.model,
        finishReason: response.finishReason,
        finalChars: content.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
      "Agent request completed with empty-response fallback",
    );
    await recordAgentEvent(ctx, {
      eventName: "agent.empty_response_recovery.failed",
      level: "warn",
      summary: "Model still returned no answer after recovery",
      metadata: {
        model: response.model,
        finishReason: response.finishReason,
        finalChars: content.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
      durationMs: durationMs(startedAt),
    });
    return {
      content: cleanFinalModelResponse(content),
      files: files.length > 0 ? files : undefined,
      tables: tables.length > 0 ? tables : undefined,
      memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
    };
  }

  const content = responseContent;
  await recordAgentEvent(ctx, {
    audit: {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      toolName: "chat",
      argumentsSummary: text,
      resultSummary: content,
      model: response.model,
      estimatedCostUsd: response.estimatedCostUsd,
    },
  });

  requestLogger.info(
    {
      durationMs: durationMs(startedAt),
      finalChars: content.length,
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length,
    },
    "Agent request complete",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.complete",
    summary: `Completed with ${content.length} chars`,
    metadata: {
      finalChars: content.length,
      fileCount: files.length,
      tableCount: tables.length,
      memoryEventCount: memoryEvents.length,
    },
    durationMs: durationMs(startedAt),
  });
  return {
    content: cleanFinalModelResponse(content),
    files: files.length > 0 ? files : undefined,
    tables: tables.length > 0 ? tables : undefined,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
  };
}

function finalSynthesisMessages(
  userText: string,
  memoryEvents: NonNullable<AgentResponse["memoryEvents"]>,
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "Write one natural Discord reply. Lead with the verdict. Be blunt, casual, and decisive; do not pad the answer with neutral caveats or a roll call of weak matches. " +
        DISCORD_RESPONSE_STYLE_GUIDANCE +
        BEST_EFFORT_RESPONSE_GUIDANCE +
        CONTEXT_DISCIPLINE_GUIDANCE +
        "For Discord history claims, use only the provided Discord tool evidence. You have no tools in this step: if the evidence does not answer the question, say plainly what you found and what is missing; never invent facts or pretend to look something up. " +
        "Do not print XML-like tool-call markup, raw tool names, or skipped redundant tool calls in the final answer. Use dates sparingly: show dates only when the user asks about timing, links, sources, proof, or exact messages, " +
        "or when a date is needed to avoid making old evidence sound current. Do not add a Sources section unless asked. " +
        "If the user asks for links, sources, receipts, proof, or exact messages, include exact Discord message URLs from the evidence. " +
        "For who-is-best/favorite/most/opinion questions, make a direct call if the evidence supports one. If it does not, say the verdict plainly, like 'No winner' or 'I can't crown anyone from that', then give the shortest reason. " +
        "When naming people from Discord evidence, only use exact handles or IDs shown in the evidence; do not infer real names or display names. " +
        "For data-analysis results, do not invent secondary stats that were not explicitly computed. If the evidence is weak or insufficient, say that briefly and do not list every weak match.",
    },
    {
      role: "user",
      content: `User request: ${userText}\n\nTool evidence:\n${renderMemoryEventsForFinalSynthesis(memoryEvents)}`,
    },
  ];
}

function renderMemoryEventsForFinalSynthesis(
  memoryEvents: NonNullable<AgentResponse["memoryEvents"]>,
) {
  return memoryEvents
    .filter((event) => event.content.trim())
    .map((event, index) => {
      const toolName =
        typeof event.metadata?.toolName === "string"
          ? event.metadata.toolName
          : "tool";
      return `[${index + 1}] ${toolName}\n${event.content.trim()}`;
    })
    .join("\n\n");
}

function emptyNoToolRecoveryMessages(messages: ChatMessage[]): ChatMessage[] {
  return [
    ...messages,
    {
      role: "system",
      content:
        "The previous model call returned an empty answer. Reply directly and concisely to the latest user using the complete conversation and reply context above. " +
        "No tools are available in this recovery call, so do not invent tool results. Do not claim context is missing when it is present above.",
    },
  ];
}

function emptyNoToolFinalFallback() {
  return "I got stuck generating that one. If this was a follow-up, reply to the message you want me to continue; otherwise ask again with the thing I should look up.";
}

function unsupportedToolCallNames(toolCalls: Array<{ name: string }>) {
  return toolCalls.map((call) => call.name).filter((name) => !toolByName(name));
}

function toolEvidenceFallback(
  memoryEvents: NonNullable<AgentResponse["memoryEvents"]>,
) {
  const latest = [...memoryEvents]
    .reverse()
    .find((event) => event.content.trim());
  if (!latest) return undefined;
  const latestSummary = [...memoryEvents].reverse().find((event) => {
    const toolName =
      typeof event.metadata?.toolName === "string"
        ? event.metadata.toolName
        : "";
    return (
      [
        "summarizeDiscordHistory",
        "getDiscordChannelTopics",
        "summarizeDiscordThread",
      ].includes(toolName) && isUsefulSummaryContent(event.content)
    );
  });
  if (latestSummary) return latestSummary.content.trim();
  const results = parseDiscordEvidenceResults(latest.content).slice(0, 5);
  if (results.length === 0) return undefined;
  const filter = latest.content
    .match(/^Applied date filter:\s*(.+)$/m)?.[1]
    ?.trim();
  const filterPhrase = fallbackFilterPhrase(filter);
  const header = filterPhrase
    ? `No solid answer from the indexed messages ${filterPhrase}. Weak matches:`
    : "No solid answer from the indexed messages. Weak matches:";
  return [
    header,
    ...results.map((result) => {
      return `- ${result.author}: "${previewText(result.content, 180)}"`;
    }),
    "",
    "I would not crown anyone from that.",
  ].join("\n");
}

function isUsefulSummaryContent(content: string) {
  const trimmed = content.trim();
  return trimmed.length > 0 && !/^Done\.$/i.test(trimmed);
}

function parseDiscordEvidenceResults(content: string) {
  const results: Array<{
    author: string;
    date: string;
    content: string;
    link: string | null;
  }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(
      /^\[\d+\]\s+(.+?)\s+(?:channel=\S+\s+)?at\s+(\S+)/,
    );
    if (!match) continue;
    const [, author, timestamp] = match;
    const snippet = lines[index + 1]?.trim();
    if (!snippet || /^https?:\/\//i.test(snippet)) continue;
    results.push({
      author,
      date: timestamp.slice(0, 10),
      content: snippet,
      link: discordMessageLinkFromLines(lines, index + 2),
    });
  }
  return results;
}

function discordMessageLinkFromLines(lines: string[], startIndex: number) {
  for (
    let index = startIndex;
    index < Math.min(lines.length, startIndex + 3);
    index += 1
  ) {
    const line = lines[index]?.trim() ?? "";
    const match = line.match(
      /https:\/\/discord(?:app)?\.com\/channels\/[^\s]+\/[^\s]+\/[^\s]+/i,
    );
    if (match) return match[0];
    if (/^\[\d+\]\s+/.test(line)) return null;
  }
  return null;
}

function fallbackFilterPhrase(filter: string | undefined) {
  if (!filter || filter === "none") return "";
  if (filter.startsWith("from "))
    return `since ${filter.slice("from ".length)}`;
  if (filter.startsWith("until "))
    return `through ${filter.slice("until ".length)}`;
  return `from ${filter}`;
}
