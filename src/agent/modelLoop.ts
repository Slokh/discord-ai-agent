import { isOpenRouterTimeoutError, type ChatMessage } from "../models/openrouter.js";
import { toolDefinitionsForModel, type ToolName } from "../tools/registry.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import { durationMs, logger, previewText } from "../util/logger.js";
import { loadSkills, renderSkillsForPrompt } from "../skills/loader.js";
import { loadPromptOverlayText } from "./promptOverlay.js";
import {
  finalizeModelRoundWithoutTools,
  modelCallCeilingFallback,
  synthesizeFinalAnswerWithoutTools,
} from "./finalSynthesis.js";
import {
  chatMessages, CURRENT_REQUEST_RESPONSE_REMINDER, insertInitialSystemContext, loadServerOverlay, prepareDiscordEmojiPromptContext,
  replyContextAttachmentCount,
  toolResultContentForPrompt,
} from "./promptBuilder.js";
import {
  MAX_MODEL_CALLS_PER_TURN,
  MAX_TOOL_ROUNDS,
  reserveModelCall,
  type ModelCallBudget,
} from "./routerShared.js";
import {
  appendAgentRuntimeAssistantToolCalls,
  appendAgentRuntimeToolResult,
  recordAgentEvent,
} from "./runtimeTranscript.js";
import { modelToolObservation, runObservedModelCall } from "./modelCallTelemetry.js";
import {
  invalidToolCallNames,
  invalidToolCallRecoveryMessage,
} from "./invalidToolCallRecovery.js";
import { executeLocalToolRoute } from "./toolDispatcher.js";
import { coerceGeneratedCsvProducerRoutes, selectExclusiveWagerTransition, selectModelToolRoutes, traceToolRequestMetadata, WagerResolutionRouter } from "./modelToolRoutes.js";
import { ForcedRandomActionRouter, randomActionAuthorizedForTurn, randomActionRequiredForTurn, randomToolForPrompt, type RandomOutcomeGuard } from "./randomOutcomeGuard.js";
import {
  FRESH_EXTERNAL_DATA_RETRY_GUIDANCE,
  FreshExternalDataGuard,
} from "./freshExternalDataGuard.js";
import { MemberAvailabilityGuard } from "./memberAvailabilityGuard.js";
import {
  currentScopedToolset,
  expandToolsetState,
  handleAdditionalToolsRequest,
  initialToolsetState,
} from "./modelToolset.js";
import { wagerHistoryRouteForPrompt, walletBalanceRouteForPrompt } from "./walletStatusGuard.js";
import { walletActionToolForPrompt } from "./walletActionGuard.js";
import { executeDeterministicWalletReadRoute } from "./deterministicWalletRoute.js";
import { injectActiveGameSession, type ActiveGameSessionContext } from "./activeGameSession.js";
import { skippedRedundantToolResult, toolResultSignature, toolRouteKey } from "./toolRepeatGuard.js";
import { compactMessagesForModelFallback, timeoutNeedsExpandedToolRetry } from "./modelTimeoutFallback.js";
import { ensureAgentTurnOutput } from "../tools/turnOutput.js";
import type { RichPresentationOutcomeGuard } from "./richPresentationOutcomeGuard.js";
import { mediaTranscriptionToolForPrompt } from "./mediaTranscriptionRoute.js";
import { PUBLIC_URL_EVIDENCE_RETRY_GUIDANCE, PublicUrlEvidenceGuard } from "./publicUrlEvidenceGuard.js";
import {
  completeDirectToolResponse,
  isSuccessfulGeneratedImageArtifact,
  synthesizeGeneratedImageArtifactIfReady,
} from "./terminalToolCompletion.js";
import { agentChatRequest, timeoutFallbackChatRequest } from "./modelPolicy.js";
import { executeIndependentToolRoutesInParallel } from "./parallelToolExecution.js";
import { CompoundToolCompletionGuard } from "./compoundToolCompletion.js";
import { recoverProviderRejectedModelCall } from "./providerRejectionFallback.js";
import { ImageEvidenceGuard, ImageGenerationGuard, ReplyContextEvidenceGuard } from "./imageEvidenceGuard.js";
import { runGuardedAgentRequest } from "./modelLoopRequest.js";
import { completeAfterToolRoundLimit } from "./modelLoopLimit.js";
import { effectiveAgentChatModel } from "../tools/agentModelTools.js";
export async function runAgentModelLoop(
  ctx: ToolContext,
  userText: string,
): Promise<AgentResponse> {
  return await runGuardedAgentRequest(ctx, userText, async (request) =>
    runAgentModelLoopInternal(
      ctx,
      userText,
      request.randomOutcomeGuard,
      request.freshExternalDataGuard,
      request.publicUrlEvidenceGuard,
      request.richPresentationOutcomeGuard,
      request.activeGame,
      request.activeGameNeedsRandomDraw,
      request.automaticStarterFunds,
    ));
}
async function runAgentModelLoopInternal(
  ctx: ToolContext,
  userText: string,
  randomOutcomeGuard: RandomOutcomeGuard,
  freshExternalDataGuard: FreshExternalDataGuard,
  publicUrlEvidenceGuard: PublicUrlEvidenceGuard,
  richPresentationOutcomeGuard: RichPresentationOutcomeGuard,
  activeGame: ActiveGameSessionContext | null,
  activeGameNeedsRandomDraw: boolean,
  automaticStarterFunds: string | null,
): Promise<AgentResponse> {
  const startedAt = Date.now();
  const imageEvidenceGuard = new ImageEvidenceGuard(ctx, userText), imageGenerationGuard = new ImageGenerationGuard(ctx, userText), replyContextEvidenceGuard = new ReplyContextEvidenceGuard(ctx), memberAvailabilityGuard = new MemberAvailabilityGuard(ctx);
  const compoundToolCompletion = new CompoundToolCompletionGuard(userText);
  const text = userText.trim();
  if (!text) return { content: "Say what you need after mentioning me." };
  const skills = renderSkillsForPrompt(await loadSkills());
  const serverOverlay = await loadServerOverlay(ctx);
  const promptOverlay = await loadPromptOverlayText(
    ctx.config.promptOverlayPath,
  );
  const discordEmojiContext = await prepareDiscordEmojiPromptContext(ctx, text);
  const messages: ChatMessage[] = chatMessages(
    text,
    skills,
    ctx.sessionMessages ?? [],
    ctx.replyContext,
    ctx.requestAttachments,
    serverOverlay,
    {
      userId: ctx.userId,
      userDisplayName: ctx.userDisplayName,
    },
    promptOverlay,
    discordEmojiContext,
  );
  if (automaticStarterFunds) {
    insertInitialSystemContext(
      messages,
      [
        "Automatic starter funding succeeded before this request. Treat the following as verified wallet evidence.",
        automaticStarterFunds,
        "Do not call requestStarterFunds again for this request or repeat the transaction hash; the transfer link is added to the footer. Continue with the user request conversationally.",
      ].join("\n"),
    );
  }
  injectActiveGameSession(messages, activeGame);
  const turnOutput = ensureAgentTurnOutput(ctx);
  const { files, tables } = turnOutput;
  const memoryEvents: NonNullable<AgentResponse["memoryEvents"]> = [];
  const toolUseCounts = new Map<ToolName, number>();
  const successfulToolCallKeys = new Set<string>();
  const toolResultSignatures = new Map<ToolName, Set<string>>();
  let repeatedToolResultCount = 0;
  const recoveryState = {
    emptyNoToolRecoveryAttempted: false,
    invalidToolCallRecoveryAttempted: false,
  };
  let forceToolUseNextRound = activeGame?.actionRequested ?? false;
  const wagerResolutionRouter = new WagerResolutionRouter();
  const forcedWalletReadRoute = wagerHistoryRouteForPrompt(ctx.config, text, ctx.replyContext) ?? walletBalanceRouteForPrompt(ctx.config, text);
  const requestedWalletActionTool = walletActionToolForPrompt(ctx.config, text);
  const forcedWalletActionTool = automaticStarterFunds && requestedWalletActionTool === "requestStarterFunds"
    ? null
    : requestedWalletActionTool;
  const forcedMediaTranscriptionTool = mediaTranscriptionToolForPrompt(ctx, text);
  const randomActionRequired = randomActionRequiredForTurn({
    userText: text,
    replyContext: ctx.replyContext,
    activeGameActionRequested: activeGameNeedsRandomDraw,
  });
  const forcedRandomAction = new ForcedRandomActionRouter(
    text,
    Boolean(ctx.config.payments?.userWalletsEnabled),
    randomActionRequired && randomToolForPrompt(text) !== "revealRandomness",
  );
  const modelCallBudget: ModelCallBudget = {
    used: 0,
    ceiling: MAX_MODEL_CALLS_PER_TURN,
    tripped: false,
  };
  const requestLogger = logger.child({
    requestId: ctx.requestId,
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
  });
  const randomActionAuthorized = randomActionAuthorizedForTurn({ userText: text, replyContext: ctx.replyContext, promptContextTexts: [serverOverlay?.enabled ? serverOverlay.systemPrompt : "", promptOverlay], activeGameActionRequested: activeGame?.actionRequested });
  let toolsetState = initialToolsetState(ctx, text, randomActionAuthorized);
  if (activeGame) toolsetState = expandToolsetState(toolsetState, { groups: ["discord-action"] });
  let hasAttemptedTool = false;
  let modelTimeoutFallbackAttempted = false;
  let primaryProviderRejected = false;
  let successfulGeneratedImageArtifact = false;
  let useRecoveryModelNextRound = false;
  requestLogger.info(
    {
      textPreview: previewText(text),
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(
        ctx.replyContext,
      ),
      hasServerOverlay: Boolean(
        serverOverlay?.enabled && serverOverlay.systemPrompt.trim(),
      ),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0,
    },
    "Agent request started",
  );
  await recordAgentEvent(ctx, {
    eventName: "agent.request.started",
    summary: previewText(text),
    metadata: {
      sessionMessageCount: ctx.sessionMessages?.length ?? 0,
      hasReplyContext: Boolean(ctx.replyContext),
      replyContextMessageId: ctx.replyContext?.messageId,
      requestAttachmentCount: ctx.requestAttachments?.length ?? 0,
      replyContextAttachmentCount: replyContextAttachmentCount(
        ctx.replyContext,
      ),
      hasServerOverlay: Boolean(
        serverOverlay?.enabled && serverOverlay.systemPrompt.trim(),
      ),
      visibleChannelCount: ctx.visibleChannelIds.length,
      mentionedUserCount: ctx.mentionedUserIds?.length ?? 0,
      mentionedChannelCount: ctx.mentionedChannelIds?.length ?? 0,
    },
  });
  if (forcedWalletReadRoute) {
    return await executeDeterministicWalletReadRoute(ctx, {
      route: forcedWalletReadRoute,
      text,
      requestLogger,
      startedAt,
      modelCallBudget,
    });
  }
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundStartedAt = Date.now();
    requestLogger.debug(
      {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
      "Agent model round starting",
    );
    const roundSpanId = `agent.model.round.${round + 1}`;
    await recordAgentEvent(ctx, {
      eventName: "agent.model.round.started",
      summary: `Round ${round + 1}: waiting for model response`,
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
    });
    await recordAgentEvent(ctx, {
      spanId: roundSpanId,
      name: `LLM round ${round + 1}`,
      status: "running",
      startedAt: new Date(roundStartedAt),
      metadata: {
        round: round + 1,
        messageCount: messages.length,
        fileCount: files.length,
        tableCount: tables.length,
        memoryEventCount: memoryEvents.length,
      },
    });
    const currentToolset = currentScopedToolset(ctx, toolsetState);
    let response;
    try {
      if (!(await reserveModelCall(ctx, modelCallBudget, "round", { round: round + 1 }))) {
        return modelCallCeilingFallback(ctx, {
          text,
          files,
          tables,
          memoryEvents,
        });
      }
      ctx.noteProgress?.();
      const forcedToolThisRound = compoundToolCompletion.takeForcedTool() ??
        imageGenerationGuard.takeForcedTool() ?? imageEvidenceGuard.takeForcedTool() ??
        (round === 0 ? forcedWalletActionTool : null) ??
        forcedRandomAction.takeToolForRound(round) ??
        (round === 0 ? forcedMediaTranscriptionTool : null);
      const wagerResolutionRoute = wagerResolutionRouter.take({ forceToolUse: forceToolUseNextRound, initialForcedTool: forcedToolThisRound ?? undefined });
      const toolChoice = wagerResolutionRoute.toolChoice;
      forceToolUseNextRound = false;
      const roundToolset = freshExternalDataGuard.toolsetForRound(publicUrlEvidenceGuard.toolsetForRound(currentToolset));
      const useRecoveryModel =
        useRecoveryModelNextRound || primaryProviderRejected;
      const chat = agentChatRequest(ctx, {
        recovery: useRecoveryModel,
        messages,
        tools: toolDefinitionsForModel({
          localTools: roundToolset.localTools,
          serverTools: roundToolset.serverTools,
        }),
        toolChoice,
      });
      const usedRecoveryModel = useRecoveryModel;
      useRecoveryModelNextRound = false;
      try {
        response = await runObservedModelCall(ctx, {
          purpose: "tool_selection",
          metadata: {
            round: round + 1,
            toolGroups: [...toolsetState.groups].sort(),
            forcedToolName: wagerResolutionRoute.forcedToolName,
            recovery: usedRecoveryModel,
          },
          chat,
        });
      } catch (error) {
        const retryExpandedToolSelection = timeoutNeedsExpandedToolRetry(messages);
        const providerFallback = await recoverProviderRejectedModelCall(ctx, {
          error,
          usedRecoveryModel,
          chat,
          round: round + 1,
          toolGroups: [...toolsetState.groups].sort(),
          forcedToolName: wagerResolutionRoute.forcedToolName,
          afterToolEvidence: hasAttemptedTool,
          afterToolsetExpansion: retryExpandedToolSelection,
          modelCallBudget,
        });
        if (providerFallback) {
          primaryProviderRejected = true;
          response = providerFallback;
        } else {
          const fallbackModel = ctx.config.openRouter?.utilityModel?.trim();
          const canFallback =
            isOpenRouterTimeoutError(error) &&
            !modelTimeoutFallbackAttempted &&
            Boolean(fallbackModel) &&
            fallbackModel !== effectiveAgentChatModel(ctx);
          if (!canFallback) throw error;
          if (!(await reserveModelCall(ctx, modelCallBudget, "timeout_fallback", { round: round + 1, fallbackModel }))) {
            throw error;
          }
          modelTimeoutFallbackAttempted = true;
          const fallbackMessages = compactMessagesForModelFallback(messages);
          await recordAgentEvent(ctx, {
            eventName: "agent.model.timeout_fallback",
            level: "warn",
            summary: `Retrying timed-out model call with ${fallbackModel}`,
            metadata: {
              round: round + 1,
              fallbackModel,
              originalMessageCount: messages.length,
              fallbackMessageCount: fallbackMessages.length,
              afterToolEvidence: hasAttemptedTool,
              afterToolsetExpansion: retryExpandedToolSelection,
            },
          });
          response = await runObservedModelCall(ctx, {
            purpose: "tool_selection_timeout_fallback",
            metadata: {
              round: round + 1,
              fallbackFor: "tool_selection",
              toolGroups: [...toolsetState.groups].sort(),
              forcedToolName: wagerResolutionRoute.forcedToolName,
              afterToolEvidence: hasAttemptedTool,
              afterToolsetExpansion: retryExpandedToolSelection,
            },
            chat: timeoutFallbackChatRequest(chat, fallbackModel, fallbackMessages),
          });
        }
      }
      ctx.abortSignal?.throwIfAborted();
      ctx.noteProgress?.();
    } catch (error) {
      await recordAgentEvent(ctx, {
        spanId: roundSpanId,
        name: `LLM round ${round + 1}`,
        status: "failed",
        startedAt: new Date(roundStartedAt),
        completedAt: new Date(),
        durationMs: durationMs(roundStartedAt),
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    const modelRoutes = selectExclusiveWagerTransition(coerceGeneratedCsvProducerRoutes(selectModelToolRoutes(response.toolCalls, currentToolset.localTools)));
    freshExternalDataGuard.noteModelResponse(response);
    publicUrlEvidenceGuard.noteModelResponse(response);
    const toolObservation = modelToolObservation(response);
    const requestedToolRequests = response.toolCalls.map(
      traceToolRequestMetadata,
    );
    const selectedLocalToolRequests = modelRoutes.map(traceToolRequestMetadata);
    requestLogger.info(
      {
        round: round + 1,
        durationMs: durationMs(roundStartedAt),
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        ...toolObservation,
        requestedToolRequests,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        selectedLocalToolRequests,
        estimatedCostUsd: response.estimatedCostUsd,
      },
      "Agent model round complete",
    );
    await recordAgentEvent(ctx, {
      spanId: roundSpanId,
      name: `LLM round ${round + 1}`,
      status: "succeeded",
      startedAt: new Date(roundStartedAt),
      completedAt: new Date(),
      durationMs: durationMs(roundStartedAt),
      metadata: {
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        ...toolObservation,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        estimatedCostUsd: response.estimatedCostUsd,
      },
    });
    await recordAgentEvent(ctx, {
      eventName: "agent.model.round.complete",
      summary: `Round ${round + 1}: ${toolObservation.requestedToolCalls.join(", ") || "no tools"}`,
      metadata: {
        round: round + 1,
        model: response.model,
        finishReason: response.finishReason,
        usage: response.usage,
        outputChars: response.content.length,
        ...toolObservation,
        requestedToolRequests,
        selectedLocalTools: modelRoutes.map((route) => route.name),
        selectedLocalToolRequests,
        estimatedCostUsd: response.estimatedCostUsd,
      },
      durationMs: durationMs(roundStartedAt),
    });
    const invalidToolCalls = invalidToolCallNames(response.toolCalls);
    if (
      modelRoutes.length === 0 &&
      !response.content.trim() &&
      invalidToolCalls.length > 0 &&
      !recoveryState.invalidToolCallRecoveryAttempted
    ) {
      recoveryState.invalidToolCallRecoveryAttempted = true;
      useRecoveryModelNextRound = true;
      messages.push(await invalidToolCallRecoveryMessage(ctx, {
        round: round + 1,
        roundStartedAt,
        text,
        invalidToolCalls,
        model: response.model,
        estimatedCostUsd: response.estimatedCostUsd,
        requestLogger,
      }));
      continue;
    }
    if (modelRoutes.length === 0) {
      if (compoundToolCompletion.hasPendingAction()) {
        if (compoundToolCompletion.shouldRetryMissingAction()) {
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: compoundToolCompletion.missingActionGuidance(),
          });
          continue;
        }
        return await completeDirectToolResponse(ctx, {
          routeName: "generateImage",
          result: { content: compoundToolCompletion.incompleteActionResponse() },
          files,
          memoryEvents,
          requestLogger,
          startedAt,
          completionKind: "partial compound tool result",
        });
      }
      const randomOutcomeDecision = await randomOutcomeGuard.inspectDraft(response.content);
      if (randomOutcomeDecision !== "allow") {
        if (randomOutcomeDecision === "retry") {
          if (randomOutcomeGuard.requiresRandomWorkflowForTurn()) {
            forcedRandomAction.forceDrawNextRound();
          }
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: randomOutcomeGuard.retryGuidance(),
          });
          continue;
        }
        return randomOutcomeGuard.blockedResponse({
          files: files.length > 0 ? files : undefined,
          tables: tables.length > 0 ? tables : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
        });
      }
      const memberAvailabilityDecision = await memberAvailabilityGuard.handleDraft(response.content, messages);
      if (memberAvailabilityDecision === "retry") continue; if (memberAvailabilityDecision !== "allow") return memberAvailabilityDecision;
      const freshExternalDataDecision = await freshExternalDataGuard.inspectDraft(response.content);
      if (freshExternalDataDecision !== "allow") {
        if (freshExternalDataDecision === "retry") {
          forceToolUseNextRound = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: FRESH_EXTERNAL_DATA_RETRY_GUIDANCE,
          });
          continue;
        }
        return freshExternalDataGuard.blockedResponse({
          files: files.length > 0 ? files : undefined,
          tables: tables.length > 0 ? tables : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
        });
      }
      const publicUrlEvidenceDecision = await publicUrlEvidenceGuard.inspectDraft(response.content);
      if (publicUrlEvidenceDecision !== "allow") {
        if (publicUrlEvidenceDecision === "retry") {
          forceToolUseNextRound = true;
          messages.push({ role: "assistant", content: response.content });
          messages.push({
            role: "user",
            content: PUBLIC_URL_EVIDENCE_RETRY_GUIDANCE,
          });
          continue;
        }
        return publicUrlEvidenceGuard.blockedResponse({
          files: files.length > 0 ? files : undefined,
          tables: tables.length > 0 ? tables : undefined,
          memoryEvents: memoryEvents.length > 0 ? memoryEvents : undefined,
        });
      }
      if (await imageGenerationGuard.retryDraft(response.content, messages, round + 1, toolUseCounts.has("generateImage"))) { toolsetState = expandToolsetState(toolsetState, { groups: ["image"] }); continue; }
      if (await imageEvidenceGuard.retryDraft(response.content, messages, round + 1) || await replyContextEvidenceGuard.retryDraft(text, response.content, messages, round + 1)) continue;
      return await finalizeModelRoundWithoutTools(ctx, {
        round: round + 1,
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
      });
    }
    await recordAgentEvent(ctx, {
      audit: {
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        userId: ctx.userId,
        toolName: "modelToolRouter",
        argumentsSummary: text,
        resultSummary: modelRoutes.map((route) => route.name).join(", "),
        model: response.model,
        estimatedCostUsd: response.estimatedCostUsd,
      },
    });
    await appendAgentRuntimeAssistantToolCalls(ctx, {
      round: round + 1,
      responseContent: response.content,
      model: response.model,
      finishReason: response.finishReason,
      estimatedCostUsd: response.estimatedCostUsd,
      routes: modelRoutes,
    });

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: modelRoutes.map((route) => ({
        id: route.id,
        type: "function",
        function: {
          name: route.name,
          arguments: route.argumentsText,
        },
      })),
    });

    const priorRoundToolResultSignatures = new Map(
      [...toolResultSignatures.entries()].map(([name, signatures]) => [name, new Set(signatures)]),
    );
    const parallelToolResults = await executeIndependentToolRoutesInParallel(ctx, modelRoutes, successfulToolCallKeys, text);
    let redundantToolReason: string | null = null;
    for (const route of modelRoutes) {
      ctx.noteProgress?.();
      hasAttemptedTool = true;
      const toolUseCount = (toolUseCounts.get(route.name) ?? 0) + 1;
      toolUseCounts.set(route.name, toolUseCount);
      const routeKey = toolRouteKey(route);
      const parallelResult = parallelToolResults.get(route.id);
      const toolStartedAt = parallelResult?.startedAt ?? Date.now();
      if (!parallelResult) {
        requestLogger.info(
          {
            toolName: route.name,
            argumentsPreview: previewText(route.argumentsText, 300),
          },
          "Local tool execution starting",
        );
        await recordAgentEvent(ctx, {
          eventName: "agent.tool.started",
          summary: route.name,
          metadata: {
            toolName: route.name,
            argumentsPreview: previewText(route.argumentsText, 300),
          },
        });
      }
      const isRepeatedExactToolCall = successfulToolCallKeys.has(routeKey);
      const result = parallelResult?.result ?? (isRepeatedExactToolCall
        ? await skippedRedundantToolResult(ctx, { text, route, toolUseCount })
        : route.name === "requestAdditionalTools"
          ? handleAdditionalToolsRequest(ctx, route, toolsetState)
          : await executeLocalToolRoute(ctx, route, text));
      forcedRandomAction.noteToolResult(route.name, result.status);
      richPresentationOutcomeGuard.noteToolResult(route.name);
      randomOutcomeGuard.noteToolResult(route.name, result.content);
      compoundToolCompletion.noteToolResult(route.name, result);
      publicUrlEvidenceGuard.noteLocalToolResult(route.name, result.status);
      wagerResolutionRouter.arm(randomOutcomeGuard.requiresWagerResolution(), randomOutcomeGuard.requiredWagerResolutionTool());
      const isRepeatedToolResult =
        !isRepeatedExactToolCall &&
        route.name !== "requestAdditionalTools" &&
        (toolResultSignatures.get(route.name)?.has(toolResultSignature(result.content)) ?? false);
      const repeatedFromPriorRound =
        priorRoundToolResultSignatures.get(route.name)?.has(toolResultSignature(result.content)) ?? false;
      const isRedundantToolCall = isRepeatedExactToolCall || isRepeatedToolResult;
      if (isRepeatedToolResult) {
        await recordAgentEvent(ctx, {
          audit: {
            guildId: ctx.guildId,
            channelId: ctx.channelId,
            userId: ctx.userId,
            toolName: "agentToolRepeatGuard",
            argumentsSummary: text,
            resultSummary: `repeated ${route.name} result on call ${toolUseCount}: ${previewText(route.argumentsText, 200)}`,
          },
        });
      }
      if (route.name === "requestAdditionalTools") {
        toolsetState = expandToolsetState(toolsetState, route.arguments);
      }
      requestLogger.info(
        {
          toolName: route.name,
          durationMs: durationMs(toolStartedAt),
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined,
          repeatedToolResult: isRepeatedToolResult || undefined,
        },
        "Local tool execution complete",
      );
      await recordAgentEvent(ctx, {
        eventName: "agent.tool.complete",
        summary: `${route.name}: ${result.content.length} chars`,
        metadata: {
          toolName: route.name,
          outputChars: result.content.length,
          fileCount: result.files?.length ?? 0,
          tableCount: result.tables?.length ?? 0,
          skippedRedundantToolCall: isRedundantToolCall || undefined,
          repeatedToolResult: isRepeatedToolResult || undefined,
        },
        durationMs: durationMs(toolStartedAt),
      });
      if (route.name !== "runCodingAgent") {
        await appendAgentRuntimeToolResult(ctx, {
          round: round + 1,
          route,
          result,
          durationMs: durationMs(toolStartedAt),
          skippedRedundantToolCall: isRedundantToolCall,
        });
      }
      if (isRepeatedExactToolCall) {
        redundantToolReason = "redundant tool call";
      } else if (isRepeatedToolResult && repeatedFromPriorRound) {
        // Same-result calls issued together in one model round should be shown
        // together, then the model gets a chance to pivot. Only repeats across
        // later rounds indicate that it is stuck.
        repeatedToolResultCount += 1;
        if (repeatedToolResultCount >= 2) {
          redundantToolReason = "repeated tool result";
        }
      } else {
        if (result.status !== "error") successfulToolCallKeys.add(routeKey);
        if (route.name !== "requestAdditionalTools") {
          const signatures =
            toolResultSignatures.get(route.name) ?? new Set<string>();
          signatures.add(toolResultSignature(result.content));
          toolResultSignatures.set(route.name, signatures);
        }
      }
      if (result.files?.length) files.push(...result.files);
      if (result.tables?.length) tables.push(...result.tables);
      successfulGeneratedImageArtifact ||= isSuccessfulGeneratedImageArtifact(route.name, result);
      if (!isRedundantToolCall) {
        memoryEvents.push({
          role: "tool",
          content: result.content,
          metadata: {
            toolName: route.name,
            arguments: route.arguments ?? {},
            files:
              result.files?.map((file) => ({
                name: file.name,
                contentType: file.contentType,
                bytes: file.data.length,
              })) ?? [],
            tables:
              result.tables?.map((table) => ({
                name: table.name,
                rows: table.rows.length,
                columns: table.columns,
              })) ?? [],
          },
        });
      }
      const repeatNudge =
        !isRedundantToolCall && toolUseCount >= 3
          ? `\n\nNote: this was ${route.name} call ${toolUseCount} this turn (max ${MAX_TOOL_ROUNDS} tool rounds). If the evidence gathered so far is sufficient, answer now instead of calling more tools.`
          : "";
      messages.push({
        role: "tool",
        tool_call_id: route.id,
        name: route.name,
        content: isRepeatedToolResult
          ? `The latest ${route.name} call returned the same evidence as an earlier ${route.name} call this turn. No new results are available from this tool. Answer now using the evidence already provided.`
          : toolResultContentForPrompt(route.name, result) + repeatNudge,
      });

      if (route.name === "runCodingAgent") {
        return await completeDirectToolResponse(ctx, {
          routeName: route.name,
          result,
          files,
          memoryEvents,
          requestLogger,
          startedAt,
          completionKind: "direct codegen tool result",
        });
      }
    }
    messages.push({ role: "system", content: CURRENT_REQUEST_RESPONSE_REMINDER });
    const compoundCompletion = compoundToolCompletion.takeTerminalAction();
    if (compoundCompletion) {
      return await completeDirectToolResponse(ctx, {
        routeName: compoundCompletion.routeName,
        result: compoundCompletion.result,
        files,
        memoryEvents,
        requestLogger,
        startedAt,
        completionKind: "grounded compound tool result",
      });
    }
    const generatedImageCompletion = await synthesizeGeneratedImageArtifactIfReady(ctx, {
      ready: successfulGeneratedImageArtifact && !compoundToolCompletion.hasPendingAction(),
      files,
      memoryEvents,
      requestLogger,
      startedAt,
    });
    if (generatedImageCompletion) return generatedImageCompletion;
    if (redundantToolReason) {
      return await synthesizeFinalAnswerWithoutTools(ctx, {
        reason: redundantToolReason,
        text,
        messages,
        files,
        memoryEvents,
        requestLogger,
        startedAt,
        modelCallBudget,
        recovery: true,
      });
    }
  }
  return await completeAfterToolRoundLimit(ctx, {
    text,
    messages,
    files,
    tables,
    memoryEvents,
    requestLogger,
    startedAt,
    modelCallBudget,
  });
}
