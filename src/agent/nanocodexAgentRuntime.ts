import type { ChatContentPart, ChatMessage } from "../models/openrouter.js";
import { localToolDefinitionsForModel, toolByName, TOOL_GROUPS, type ToolName } from "../tools/registry.js";
import { scopedToolset } from "../tools/toolScope.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import { ensureAgentTurnOutput } from "../tools/turnOutput.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { effectiveAgentChatModel } from "../tools/agentModelTools.js";
import { PRIMARY_AGENT_REASONING } from "./modelPolicy.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { durationMs, previewText } from "../util/logger.js";
import { injectActiveGameSession } from "./activeGameSession.js";
import { correctKnownCapabilityClaim } from "./capabilityClaimGuard.js";
import { extractDiscordEmojiResponseIntent } from "./emojiResponseIntent.js";
import { runGuardedAgentRequest, type GuardedAgentRequest } from "./guardedAgentRequest.js";
import { withAgentRuntimeTimeouts } from "./runtimeTimeouts.js";
import { loadPromptOverlayText } from "./promptOverlay.js";
import {
  chatMessages,
  loadServerOverlay,
  prepareDiscordEmojiPromptContext,
  toolResultContentForPrompt,
} from "./promptBuilder.js";
import type { AgentToolRoute } from "./routerShared.js";
import { appendAgentRuntimeToolResult, recordAgentEvent } from "./runtimeTranscript.js";
import { executeLocalToolRoute } from "./toolDispatcher.js";
import { nanoCodexSessionId, runNanoCodexRuntime, type NanoCodexRuntimeEvent } from "./nanocodexRuntime.js";
import {
  loadNanoCodexSessionSnapshot,
  nanoCodexSessionResumeContract,
  storeNanoCodexSessionSnapshot,
} from "./nanocodexSessionState.js";

export async function executeNanoCodexAgentRuntime(input: {
  toolContext: ToolContext;
  text: string;
  timeoutMs: number;
  silenceTimeoutMs?: number;
  hardTimeoutMs?: number;
  binary?: string;
  runRuntime?: typeof runNanoCodexRuntime;
}): Promise<AgentResponse> {
  return withAgentRuntimeTimeouts({
    hardTimeoutMs: input.hardTimeoutMs ?? input.timeoutMs,
    silenceTimeoutMs: input.silenceTimeoutMs,
    label: "Discord AI Agent NanoCodex request",
    promiseFactory: async (noteProgress, abortSignal) => {
      const ctx = input.toolContext;
      ctx.noteProgress = noteProgress;
      ctx.abortSignal = abortSignal;
      ctx.requestText = input.text;
      return runGuardedAgentRequest(ctx, input.text, (request, executionText) =>
        runRetainedNanoCodexTurn({ ...input, text: executionText, toolContext: ctx, request })
      );
    },
  });
}

async function runRetainedNanoCodexTurn(input: {
  toolContext: ToolContext;
  text: string;
  binary?: string;
  runRuntime?: typeof runNanoCodexRuntime;
  request: GuardedAgentRequest;
}): Promise<AgentResponse> {
  const ctx = input.toolContext;
  const apiKey = ctx.config.openRouter.apiKey;
  const session = ctx.agentRuntimeSession;
  const executionId = ctx.agentRuntimeExecutionId;
  const requestId = ctx.requestId;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for NanoCodex");
  if (!ctx.agentRuntime || !session || !executionId || !requestId) {
    throw new Error("NanoCodex requires a canonical agent runtime session and execution");
  }

  const text = input.text.trim();
  if (!text) return { content: "Say what you need after mentioning me." };

  const randomGuard = input.request.randomOutcomeGuard;
  const freshDataGuard = input.request.freshExternalDataGuard;
  const publicUrlGuard = input.request.publicUrlEvidenceGuard;
  const presentationGuard = input.request.richPresentationOutcomeGuard;
  const turnOutput = ensureAgentTurnOutput(ctx);
  const memoryEvents: NonNullable<AgentResponse["memoryEvents"]> = [];
  const initialPrompt = await buildNanoCodexPrompt(
    ctx,
    text,
    false,
    input.request.automaticStarterFunds,
    input.request.activeGame,
  );
  // A stable full schema improves NanoCodex prompt-cache reuse and removes the
  // old mid-turn tool-expansion protocol. Deployment filtering still prevents
  // unavailable capabilities from entering the model contract.
  const localTools = scopedToolset({ config: ctx.config, groups: new Set(TOOL_GROUPS) }).localTools;
  const toolDefinitions = localToolDefinitionsForModel(localTools);
  const resumeContract = nanoCodexSessionResumeContract({
    instructions: initialPrompt.instructions,
    tools: toolDefinitions,
  });
  const resume = await loadNanoCodexSessionSnapshot({
    agentRuntime: ctx.agentRuntime,
    sessionId: session.sessionId,
    resumeContract,
  });
  const prompt = resume
    ? await buildNanoCodexPrompt(ctx, text, true, input.request.automaticStarterFunds, input.request.activeGame)
    : initialPrompt;
  const allowedTools = new Set<ToolName>(localTools.map((tool) => tool.name));
  let webEvidenceObserved = false;
  let toolSequence = 0;
  const model = effectiveAgentChatModel(ctx) ?? ctx.config.openRouter.chatModel;

  const result = await (input.runRuntime ?? runNanoCodexRuntime)({
    binary: input.binary,
    apiKey,
    apiBaseUrl: ctx.config.openRouter.baseUrl,
    model,
    thinking: PRIMARY_AGENT_REASONING,
    reasoningMode: "standard",
    instructions: prompt.instructions,
    prompt: prompt.prompt,
    requestId,
    sessionId: nanoCodexSessionId(session.sessionId),
    resume,
    tools: toolDefinitions,
    hostedWebSearch: true,
    abortSignal: ctx.abortSignal,
    onProgress: ctx.noteProgress,
    onEvent: async (event) => {
      if (isSuccessfulNanoWebSearchEvent(event)) webEvidenceObserved = true;
      await recordNanoCodexEvent(ctx, event);
    },
    executeTool: async (call) => {
      const startedAt = Date.now();
      toolSequence += 1;
      const tool = toolByName(call.name);
      if (!tool || !allowedTools.has(tool.name)) {
        await recordAgentEvent(ctx, {
          eventName: "agent.nanocodex.tool_rejected",
          level: "warn",
          summary: `Rejected unavailable tool ${call.name}`,
          metadata: { toolName: call.name, callId: call.callId },
        });
        return { success: false, output: `Tool ${call.name} is not available for this request.` };
      }
      const args = objectArguments(call.arguments);
      const route: AgentToolRoute = {
        id: call.callId,
        name: tool.name,
        arguments: args,
        argumentsText: JSON.stringify(args),
      };
      await recordAgentEvent(ctx, {
        eventName: "agent.tool.started",
        summary: route.name,
        metadata: { toolName: route.name, callId: route.id, argumentsPreview: previewText(route.argumentsText, 300) },
      });
      const toolResult = await executeLocalToolRoute(ctx, route, text);
      randomGuard.noteToolResult(route.name, toolResult);
      presentationGuard.noteToolResult(route.name);
      publicUrlGuard.noteLocalToolResult(route.name, toolResult.status);
      if (toolResult.files?.length) turnOutput.files.push(...toolResult.files);
      if (toolResult.tables?.length) turnOutput.tables.push(...toolResult.tables);
      memoryEvents.push({
        role: "tool",
        content: toolResult.content,
        metadata: { toolName: route.name, arguments: args },
      });
      const elapsed = durationMs(startedAt);
      await appendAgentRuntimeToolResult(ctx, {
        round: toolSequence,
        route,
        result: toolResult,
        durationMs: elapsed,
        skippedRedundantToolCall: false,
      });
      await recordAgentEvent(ctx, {
        eventName: "agent.tool.complete",
        summary: `${route.name}: ${toolResult.content.length} chars`,
        durationMs: elapsed,
        metadata: {
          toolName: route.name,
          callId: route.id,
          outputChars: toolResult.content.length,
          fileCount: toolResult.files?.length ?? 0,
          tableCount: toolResult.tables?.length ?? 0,
          status: toolResult.status ?? "ok",
        },
      });
      return {
        success: toolResult.status !== "error",
        output: toolResultContentForPrompt(route.name, toolResult),
        metadata: {
          status: toolResult.status ?? "ok",
          fileCount: toolResult.files?.length ?? 0,
          tableCount: toolResult.tables?.length ?? 0,
        },
      };
    },
  });

  await storeNanoCodexSessionSnapshot({
    agentRuntime: ctx.agentRuntime,
    sessionId: session.sessionId,
    executionId,
    result,
    resumeContract,
  });
  if (webEvidenceObserved) {
    const hostedEvidence = {
      content: result.finalMessage,
      serverToolUse: { web_search_requests: 1 },
      urlCitations: [{ url: "nanocodex://hosted-web-search", title: "NanoCodex hosted web evidence", startIndex: 0, endIndex: 0 }],
    };
    freshDataGuard.noteModelResponse(hostedEvidence);
    publicUrlGuard.noteModelResponse(hostedEvidence);
  }
  const emojiIntent = extractDiscordEmojiResponseIntent(
    cleanResponse(result.finalMessage, ctx.config.maxReplyChars),
    ctx.discordEmojiReactionChoices ?? [],
  );
  const output = turnOutput.snapshot();
  const response: AgentResponse = {
    content: emojiIntent.content,
    sourceMessageReaction: emojiIntent.sourceMessageReaction,
    files: output.files.length > 0 ? [...output.files] : undefined,
    tables: output.tables.length > 0 ? [...output.tables] : undefined,
    footerLines: output.footerLines.length > 0 ? [...output.footerLines] : undefined,
    discordPresentation: output.presentation,
    memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
  };
  const capabilityCorrection = correctKnownCapabilityClaim(ctx, text, response.content, model);
  response.content = capabilityCorrection.content;
  if (capabilityCorrection.corrected) {
    await recordAgentEvent(ctx, {
      eventName: "agent.capability_claim.corrected",
      level: "warn",
      summary: `Corrected ${capabilityCorrection.capability ?? "known"} capability claim`,
      metadata: { capability: capabilityCorrection.capability ?? null, model },
    });
  }
  await recordAgentEvent(ctx, {
    eventName: "agent.nanocodex.complete",
    summary: `NanoCodex completed with ${toolSequence} tool calls`,
    metadata: { usage: result.usage, toolCalls: toolSequence, resumed: Boolean(resume), webEvidenceObserved },
  });
  return response;
}

async function buildNanoCodexPrompt(
  ctx: ToolContext,
  text: string,
  resumed: boolean,
  automaticStarterFunds: string | null,
  activeGame: GuardedAgentRequest["activeGame"],
) {
  const skills = renderSkillsForPrompt(await loadSkills());
  const serverOverlay = await loadServerOverlay(ctx);
  const promptOverlay = await loadPromptOverlayText(ctx.config.promptOverlayPath);
  const emojiContext = await prepareDiscordEmojiPromptContext(ctx, text);
  const messages = chatMessages(
    text,
    skills,
    ctx.sessionMessages ?? [],
    ctx.replyContext,
    ctx.requestAttachments,
    serverOverlay,
    { userId: ctx.userId, userDisplayName: ctx.userDisplayName, mentionedUsers: ctx.mentionedUsers },
    promptOverlay,
    emojiContext,
  );
  if (automaticStarterFunds) {
    messages.splice(Math.max(0, messages.length - 1), 0, {
      role: "system",
      content: [
        "Automatic starter funding succeeded before this request. Treat this as verified wallet evidence.",
        automaticStarterFunds,
        "Do not call requestStarterFunds again this turn.",
      ].join("\n"),
    });
  }
  injectActiveGameSession(messages, activeGame);
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => textContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const conversational = messages.filter((message) => message.role !== "system");
  const promptMessages = resumed ? conversational.slice(-1) : conversational;
  return {
    instructions,
    prompt: promptMessages.map((message) => `${message.role.toUpperCase()}: ${textContent(message.content)}`).join("\n\n"),
  };
}

function textContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((part: ChatContentPart) => {
    if (part.type === "text") return part.text;
    return `[Image available to inspection tools: ${part.image_url.url}]`;
  }).join("\n");
}

function objectArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isSuccessfulNanoWebSearchEvent(event: NanoCodexRuntimeEvent) {
  if (event.type !== "tool.result") return false;
  const serialized = JSON.stringify(event.payload);
  return /(?:web__run|web_search)/i.test(serialized) && /https?:\/\//i.test(serialized) && !/"status":"failed"/i.test(serialized);
}

async function recordNanoCodexEvent(ctx: ToolContext, event: NanoCodexRuntimeEvent) {
  if (event.type === "assistant.delta" || event.type === "reasoning.summary.delta" || event.type === "api.event") return;
  await recordAgentEvent(ctx, {
    eventName: `agent.nanocodex.${event.type}`,
    summary: `NanoCodex ${event.type}`,
    metadata: { nanoSequence: event.seq, nanoRequestId: event.request_id },
  });
}
