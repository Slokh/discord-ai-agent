import type { AgentQualityCohort } from "../agent/runtimeLedger.js";
import type { AgentRuntimeTurnEnvelope } from "../agent/runtimeEnvelope.js";
import { discordChannelThreadKey } from "./mentionParsing.js";

export type DiscordAgentRequestKind = NonNullable<AgentRuntimeTurnEnvelope["requestKind"]>;

/** Deterministic authority and observability policy for every Discord execution origin. */
export function agentExecutionPolicy(requestKind: DiscordAgentRequestKind) {
  const scheduled = requestKind === "scheduled";
  return {
    qualityCohort: (scheduled ? "scheduled" : "member") as AgentQualityCohort,
    sessionKind: scheduled ? "scheduled_request" as const : "discord_channel" as const,
    mutationAuthorizedByCurrentInput: requestKind === "message",
    readOnlyExecution: scheduled,
    loadAmbientConversationMemory: !scheduled,
  };
}

export function discordAgentThreadKey(input: {
  requestKind: DiscordAgentRequestKind;
  guildId: string;
  channelId: string;
  requesterId: string;
  agentSessionId?: string;
  requestId: string;
}) {
  return input.requestKind === "scheduled"
    ? `discord-scheduled:${input.guildId}:${input.requesterId}:${input.agentSessionId ?? input.requestId}`
    : discordChannelThreadKey(input.guildId, input.channelId);
}
