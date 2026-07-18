import { type Client, type Interaction, type Message } from "discord.js";
import { enqueueAgentRuntimeSessionExecution } from "../../agent/runtimeControlPlane.js";
import { agentRuntimeTurnInputText, type AgentRuntimeTurnEnvelope } from "../../agent/runtimeEnvelope.js";
import { ensureAgentRuntimePromptExecution } from "../../agent/runtimeLedger.js";
import { durationMs, logger } from "../../util/logger.js";
import { runWithTrace } from "../../util/trace.js";
import { executeDiscordAgentRequest } from "../agentDelivery.js";
import { checkIngressBudget } from "../messageIngress.js";
import { discordChannelThreadKey } from "../mentionParsing.js";
import { DiscordResponseSink } from "../responseSink.js";
import { fetchDiscordMessage, recordTraceEvent, type DiscordAgentRequestInput } from "../requestContext.js";
import { prepareDiscordAgentTurn } from "../turnPreparation.js";
import { buildDiscordModal, discordComponentToken } from "./renderer.js";
import { normalizeMessageComponentInteraction, normalizeModalSubmission } from "./interactionNormalization.js";
import { DiscordInteractionResponder } from "./interactionResponder.js";

export async function handleDiscordRichInteraction(
  input: DiscordAgentRequestInput,
  client: Client,
  interaction: Interaction,
): Promise<boolean> {
  if (!isSupportedInteraction(interaction)) return false;
  const rich = interaction;
  const responder = new DiscordInteractionResponder(rich);
  const parsed = discordComponentToken(rich.customId);
  if (!parsed) return false;
  if (parsed.submission && parsed.kind !== "modal") {
    await responder.ephemeral("That control has an invalid submission type.");
    return true;
  }
  if (!hasGuildMessageScope(rich)) {
    await responder.ephemeral("That control is not attached to a server message.");
    return true;
  }
  if (input.config.discord.guildId && rich.guildId !== input.config.discord.guildId) {
    await responder.ephemeral("That control is not available in this server.");
    return true;
  }

  const modalLaunch = parsed.kind === "modal" && !parsed.submission && rich.isMessageComponent();
  try {
    if (!modalLaunch) {
      if (rich.isModalSubmit() && !rich.isFromMessage()) {
        await responder.ephemeral("That form is no longer attached to a message.");
        return true;
      }
      await responder.acknowledgeUpdate();
    }
    const resolutionPromise = input.repo.resolveDiscordComponentAction({
      token: parsed.token,
      guildId: rich.guildId,
      channelId: rich.channelId,
      responseMessageId: rich.message.id,
      userId: rich.user.id,
      consume: false,
    });
    const resolution = modalLaunch
      ? await withinModalResponseDeadline(resolutionPromise)
      : await resolutionPromise;
    if (!resolution.ok) {
      await responder.ephemeral(interactionErrorMessage(resolution.reason));
      return true;
    }
    const action = resolution.record.action;
    if (modalLaunch) {
      if (action.type !== "modal") {
        await responder.ephemeral("That control no longer matches its saved action.");
        return true;
      }
      await responder.showModal(buildDiscordModal(rich.customId, action.modal!));
      return true;
    }
    const actionMatches = parsed.kind === "modal" ? action.type === "modal" : action.type !== "modal";
    const interactionMatches = parsed.submission ? rich.isModalSubmit() : rich.isMessageComponent();
    if (!actionMatches || !interactionMatches) {
      await responder.ephemeral("That control no longer matches its saved action.");
      return true;
    }
    await runWithTrace({ traceId: rich.id, requestId: rich.id, guildId: rich.guildId, channelId: rich.channelId, userId: rich.user.id, messageId: rich.message.id }, async () => {
      await enqueueInteractionTurn(input, client, rich, parsed.token, resolution.record.sourceMessageId, resolution.record.originatingExecutionId, action.prompt, parsed.submission ? "modal" : "component", action.metadata);
    });
  } catch (error) {
    logger.error({ err: error, interactionId: rich.id }, "Discord rich interaction failed");
    await responder.ephemeral("I couldn't process that control. Please try again.");
    return true;
  }
  return true;
}

async function enqueueInteractionTurn(
  input: DiscordAgentRequestInput,
  client: Client,
  interaction: ScopedRichInteraction,
  token: string,
  sourceMessageId: string,
  originatingExecutionId: string,
  basePrompt: string,
  requestKind: "component" | "modal",
  actionMetadata?: DiscordStoredActionMetadata,
) {
  const startedAt = Date.now();
  const sourceMessage = await fetchDiscordMessage(client, interaction.channelId, sourceMessageId);
  if (!sourceMessage.inGuild()) throw new Error("Rich component source message is no longer a guild message.");
  if (await input.repo.isUserInteractionBlocked({ guildId: interaction.guildId!, userId: interaction.user.id })) return;
  const normalizedModal = interaction.isModalSubmit() ? normalizeModalSubmission(interaction) : undefined;
  const interactionContext: NonNullable<AgentRuntimeTurnEnvelope["interaction"]> = interaction.isModalSubmit()
    ? normalizedModal!.submission
    : normalizeMessageComponentInteraction(interaction);
  const modelInputText = agentRuntimeTurnInputText({ text: basePrompt, interaction: interactionContext });
  const budget = await checkIngressBudget(input, { guildId: interaction.guildId!, channelId: interaction.channelId, userId: interaction.user.id, requestId: interaction.id, text: modelInputText });
  if (!budget.allowed) {
    await new DiscordInteractionResponder(interaction).ephemeral(budget.message);
    return;
  }
  const consumed = await input.repo.resolveDiscordComponentAction({
    token,
    guildId: interaction.guildId!,
    channelId: interaction.channelId,
    responseMessageId: interaction.message.id,
    userId: interaction.user.id,
    consume: true,
  });
  if (!consumed.ok) {
    await new DiscordInteractionResponder(interaction).ephemeral(interactionErrorMessage(consumed.reason));
    return;
  }
  const displayName = interaction.inGuild() && interaction.member && "displayName" in interaction.member
    ? interaction.member.displayName
    : interaction.user.globalName ?? interaction.user.username;
  const threadKey = discordChannelThreadKey(interaction.guildId!, interaction.channelId);
  const runtime = await ensureAgentRuntimePromptExecution({
    agentRuntime: input.agentRuntime,
    guildId: interaction.guildId!, channelId: interaction.channelId, userId: interaction.user.id, userDisplayName: displayName,
    threadKey, requestId: interaction.id, text: basePrompt, rawContent: basePrompt, discordUrl: interaction.message.url,
    status: "queued", source: `discord.${requestKind}`, executorName: input.agentExecutor?.name ?? "in-process", appRevision: input.config.appRevision, config: input.config,
  });
  if (!runtime) throw new Error("Could not create the agent runtime ledger for the Discord interaction.");
  const responseSink = new DiscordResponseSink({ client, sourceMessage, statusMessage: interaction.message, maxReplyChars: input.config.maxReplyChars, deliveryKey: interaction.id, logger: logger.child({ traceId: interaction.id, userId: interaction.user.id }) });
  const request = {
    requestId: interaction.id,
    agentSessionId: runtime.session.sessionId,
    agentExecutionId: runtime.executionId,
    text: basePrompt,
    rawContent: basePrompt,
    botRoleIds: [],
    messageStartedAt: startedAt,
    requestKind,
    userId: interaction.user.id,
    userDisplayName: displayName,
    interaction: interactionContext,
    requestAttachments: normalizedModal?.attachments,
  };
  const prepared = await prepareDiscordAgentTurn({ context: input, client, message: sourceMessage, responseSink, request, agentRuntimeExecution: runtime, requestLogger: logger, source: `discord.${requestKind}` });
  await input.deliveryObligations?.upsertPending({ executionId: runtime.executionId, threadKey, guildId: interaction.guildId!, channelId: interaction.channelId, statusChannelId: interaction.message.channelId, statusMessageId: interaction.message.id, sourceMessageId, metadata: { requestId: interaction.id, requestKind } });
  await recordTraceEvent(input.repo, { eventName: "discord.component.accepted", summary: `Accepted Discord ${requestKind} interaction`, metadata: { originatingExecutionId, interactionExecutionId: runtime.executionId, sourceMessageId, actionMetadata: actionMetadata ?? null }, durationMs: durationMs(startedAt) });
  if (input.jobs) {
    if (!input.agentRuntime) throw new Error("Agent runtime repository is required to enqueue Discord interactions.");
    await enqueueAgentRuntimeSessionExecution({
      agentRuntime: input.agentRuntime, jobs: input.jobs, session: runtime.session,
      execution: { executionId: runtime.executionId, traceId: interaction.id }, threadKey,
      queue: { runId: interaction.id, traceId: interaction.id, guildId: interaction.guildId, channelId: interaction.channelId, messageId: sourceMessageId, userId: interaction.user.id, responseChannelId: interaction.message.channelId, responseMessageId: interaction.message.id, turnEnvelopeArtifactId: prepared.turnEnvelopeArtifactId, inputLinesArtifactId: prepared.inputLinesArtifactId, text: basePrompt, rawContent: basePrompt, mentionKind: requestKind, botRoleIds: [], requesterDisplayName: displayName, enqueuedAt: new Date().toISOString() },
    });
    return;
  }
  await executeDiscordAgentRequest(input, client, sourceMessage, responseSink, { ...request, turnEnvelope: prepared.turnEnvelope, inputLinesArtifactId: prepared.inputLinesArtifactId });
}

type SupportedRichInteraction = Extract<Interaction, { customId: string }>;
type ScopedRichInteraction = SupportedRichInteraction & { guildId: string; channelId: string; message: Message };
type DiscordStoredActionMetadata = { componentPath: string; label?: string };

function isSupportedInteraction(interaction: Interaction): interaction is SupportedRichInteraction {
  return interaction.isMessageComponent() || interaction.isModalSubmit();
}

function hasGuildMessageScope(interaction: SupportedRichInteraction): interaction is ScopedRichInteraction {
  return Boolean(interaction.guildId && interaction.channelId && interaction.message);
}

function interactionErrorMessage(reason: string) {
  if (reason === "wrong_user") return "That control belongs to the person who requested it.";
  if (reason === "expired") return "That control has expired. Ask me to create a fresh one.";
  if (reason === "consumed") return "That control has already been used.";
  return "That control is no longer available.";
}

async function withinModalResponseDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Discord modal action lookup exceeded its response deadline.")), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
