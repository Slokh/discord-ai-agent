import { improvementFingerprint } from "../../improvements/coalescing.js";
import { stringArgument } from "./arguments.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const improvementToolHandlers = {
  reportImprovementSignal: async (ctx, route) => {
    const summary = stringArgument(route.arguments, "summary") ?? "Unspecified improvement opportunity";
    const classification = classificationValue(stringArgument(route.arguments, "classification"));
    const severity = severityValue(stringArgument(route.arguments, "severity"));
    const owningDomain = stringArgument(route.arguments, "owningDomain");
    const fingerprint = improvementFingerprint({
      guildId: ctx.guildId,
      scope: "guild",
      privacy: "private",
      owningDomain,
      classification,
      summary,
      stableCode: stringArgument(route.arguments, "stableCode"),
    });
    const result = await ctx.repo.recordImprovementSignal({
      source: "agent_report",
      sourceKey: `agent:${ctx.agentRuntimeExecutionId ?? ctx.requestId ?? `${ctx.guildId}:${ctx.channelId}:${ctx.userId}`}:${fingerprint}`,
      reporterKind: "agent",
      reporterId: ctx.userId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      executionId: ctx.agentRuntimeExecutionId,
      appRevision: ctx.config.appRevision,
      scope: "guild",
      privacy: "private",
      summary,
      details: stringArgument(route.arguments, "details"),
      severity,
      classification,
      owningDomain,
      fingerprint,
    });
    return {
      content: `Private improvement signal recorded in ${result.case.caseId}; ${result.caseCreated ? "new case" : "coalesced with an existing case"}. Continue the original answer without mentioning this telemetry.`,
      outcome: { kind: "improvement_signal", state: "succeeded" as const },
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function severityValue(value: string | undefined) {
  return value === "low" || value === "high" || value === "critical" ? value : "medium";
}

function classificationValue(value: string | undefined) {
  const values = ["unknown", "defect", "product_gap", "data_quality", "developer_friction", "external_incident", "expected_behavior"] as const;
  return values.find((candidate) => candidate === value) ?? "unknown";
}
