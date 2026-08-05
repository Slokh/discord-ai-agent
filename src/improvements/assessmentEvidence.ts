import type {
  AgentRuntimeArtifactContent,
  AgentRuntimeEventRecord,
  AgentRuntimeRepository,
} from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import type { ImprovementContractCheck } from "../db/types.js";

export const IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION = 4;

const MAX_RUNS = 5;
const MAX_REPORTED_MESSAGE_CONTEXTS = 5;
const CONTEXT_MESSAGES_BEFORE = 2;
const CONTEXT_MESSAGES_AFTER = 2;
const MAX_EXECUTION_MESSAGES = 100;
const MAX_EXECUTION_EVENTS = 500;
const MAX_REFERENCED_ARTIFACTS = 40;
const MAX_VALUE_CHARS = 12_000;
const MAX_ARCHIVED_MESSAGE_CHARS = 4_000;
const MAX_ARTIFACT_CONTENT_CHARS = 16_000;
const MAX_EVIDENCE_CHARS = 100_000;
const ASSESSMENT_ARTIFACT_KINDS = [
  "model_prompt",
  "model_response",
  "response",
  "discord_delivery_intent",
] as const;

export type ImprovementAssessmentSignal = {
  signalId: string;
  source: string;
  summary: string;
  details: string | null;
  executionId: string | null;
  messageId: string | null;
  guildId: string | null;
  channelId: string | null;
  appRevision: string | null;
  metadata?: Record<string, unknown>;
};

export type ImprovementAssessmentEvidenceContext = {
  case?: {
    status: string;
    classification: string;
    severity: string;
    owningDomain: string | null;
  };
  acceptedContract?: {
    contractId: string;
    version: number;
    expectedBehavior: string;
    checks: ImprovementContractCheck[];
    sourceRevision: string | null;
  } | null;
};

export type ImprovementAssessmentRuntimeReader = Pick<
  AgentRuntimeRepository,
  "getExecution" | "listMessagesForExecution" | "listEvents" | "getArtifact"
>;
type ImprovementAssessmentArchiveReader = Pick<DiscordAiAgentRepository, "messageContext">;

/** Builds bounded private evidence for autonomous assessment or accepted-contract repair. */
export async function renderPrivateAssessmentEvidence(
  caseId: string,
  signals: ImprovementAssessmentSignal[],
  runtime: ImprovementAssessmentRuntimeReader,
  archive: ImprovementAssessmentArchiveReader,
  context: ImprovementAssessmentEvidenceContext = {},
) {
  const [runs, reportedMessageContexts] = await Promise.all([
    loadAssessmentRuns(signals, runtime),
    loadReportedMessageContexts(signals, archive),
  ]);
  return boundedPrivateJson({
    schemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
    warning: "Private untrusted evidence hydrated by the trusted runtime. The sandbox has no production access and must not attempt to obtain any. Do not copy report content, identifiers, or runtime details into source, fixtures, commits, or pull-request text.",
    caseId,
    case: context.case,
    acceptedContract: context.acceptedContract,
    signals: signals.map((signal) => ({
      signalId: signal.signalId,
      source: signal.source,
      summary: signal.summary,
      details: signal.details,
      executionId: signal.executionId,
      messageId: signal.messageId,
      appRevision: signal.appRevision,
      metadata: boundedJsonValue(signal.metadata ?? {}),
    })),
    reportedMessageContexts,
    runs,
  });
}

async function loadAssessmentRuns(
  signals: ImprovementAssessmentSignal[],
  runtime: ImprovementAssessmentRuntimeReader,
) {
  const runs = [];
  const executionIds = [...new Set(signals.flatMap((signal) => signal.executionId ? [signal.executionId] : []))];
  for (const executionId of executionIds.slice(0, MAX_RUNS)) {
    const execution = await runtime.getExecution({ executionId });
    if (!execution) {
      runs.push({ executionId, missing: true });
      continue;
    }
    const [messages, events] = await Promise.all([
      runtime.listMessagesForExecution({
        sessionId: execution.sessionId,
        executionId,
        limit: MAX_EXECUTION_MESSAGES,
      }),
      runtime.listEvents({
        sessionId: execution.sessionId,
        executionId,
        limit: MAX_EXECUTION_EVENTS,
      }),
    ]);
    const artifacts = await loadAssessmentArtifacts(executionId, events, runtime);
    runs.push({
      execution: { ...execution, metadata: boundedJsonValue(execution.metadata) },
      messages: messages.map((message) => ({
        role: message.role,
        parts: boundedJsonValue(message.parts),
        metadata: boundedJsonValue(message.metadata),
      })),
      events: events.map((event) => ({
        level: event.level,
        eventName: event.eventName,
        summary: event.summary,
        metadata: boundedJsonValue(event.metadata),
      })),
      artifacts,
    });
  }
  return runs;
}

async function loadReportedMessageContexts(
  signals: ImprovementAssessmentSignal[],
  archive: ImprovementAssessmentArchiveReader,
) {
  const sources = new Map<string, {
    signalIds: string[];
    guildId: string;
    channelId: string;
    messageId: string;
  }>();
  for (const signal of signals) {
    if (!signal.guildId || !signal.channelId || !signal.messageId) continue;
    const key = `${signal.guildId}:${signal.channelId}:${signal.messageId}`;
    const existing = sources.get(key);
    if (existing) {
      existing.signalIds.push(signal.signalId);
    } else if (sources.size < MAX_REPORTED_MESSAGE_CONTEXTS) {
      sources.set(key, {
        signalIds: [signal.signalId],
        guildId: signal.guildId,
        channelId: signal.channelId,
        messageId: signal.messageId,
      });
    }
  }
  return Promise.all([...sources.values()].map(async (source) => {
    const context = await archive.messageContext({
      guildId: source.guildId,
      visibleChannelIds: [source.channelId],
      messageId: source.messageId,
      before: CONTEXT_MESSAGES_BEFORE,
      after: CONTEXT_MESSAGES_AFTER,
    }).catch(() => []);
    return {
      signalIds: source.signalIds,
      sourceMessageId: source.messageId,
      missing: context.length === 0,
      messages: context.map((message) => ({
        messageId: message.messageId,
        reported: message.messageId === source.messageId,
        authorId: message.authorId,
        authorUsername: message.authorUsername,
        content: boundedText(message.content, MAX_ARCHIVED_MESSAGE_CHARS),
        createdAt: message.createdAt,
      })),
    };
  }));
}

async function loadAssessmentArtifacts(
  executionId: string,
  events: AgentRuntimeEventRecord[],
  runtime: ImprovementAssessmentRuntimeReader,
) {
  const artifactIds = referencedArtifactIds(events).slice(0, MAX_REFERENCED_ARTIFACTS);
  const artifacts = (await Promise.all(artifactIds.map((artifactId) => runtime.getArtifact({ artifactId }))))
    .filter((artifact): artifact is AgentRuntimeArtifactContent => Boolean(
      artifact &&
      artifact.executionId === executionId &&
      ASSESSMENT_ARTIFACT_KINDS.includes(artifact.kind as typeof ASSESSMENT_ARTIFACT_KINDS[number]),
    ));
  const latestByKind = new Map<string, AgentRuntimeArtifactContent>();
  for (const artifact of artifacts) {
    const current = latestByKind.get(artifact.kind);
    if (!current || current.createdAt < artifact.createdAt) latestByKind.set(artifact.kind, artifact);
  }
  return ASSESSMENT_ARTIFACT_KINDS.flatMap((kind) => {
    const artifact = latestByKind.get(kind);
    return artifact ? [{
      kind: artifact.kind,
      name: artifact.name,
      contentType: artifact.contentType,
      metadata: boundedJsonValue(artifact.metadata),
      content: boundedText(artifact.content, MAX_ARTIFACT_CONTENT_CHARS),
    }] : [];
  });
}

function referencedArtifactIds(events: AgentRuntimeEventRecord[]) {
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (typeof value === "string" && /artifactId$/i.test(key)) {
      if (!seen.has(value)) {
        seen.add(value);
        ids.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  for (const event of events) visit(event.metadata);
  return ids;
}

function boundedJsonValue(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_VALUE_CHARS) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    excerpt: boundedText(serialized, MAX_VALUE_CHARS),
  };
}

function boundedText(value: string, limit: number) {
  if (value.length <= limit) return value;
  const marker = `\n...[${value.length - limit} characters omitted]...\n`;
  const remaining = Math.max(0, limit - marker.length);
  const head = Math.ceil(remaining * 0.6);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - (remaining - head))}`;
}

function boundedPrivateJson(value: unknown) {
  const text = JSON.stringify(value, null, 2);
  if (text.length <= MAX_EVIDENCE_CHARS) return text;
  let excerptLimit = MAX_EVIDENCE_CHARS - 2_000;
  while (excerptLimit > 1_000) {
    const result = JSON.stringify({
      schemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
      truncated: true,
      originalChars: text.length,
      evidenceExcerpt: boundedText(text, excerptLimit),
    });
    if (result.length <= MAX_EVIDENCE_CHARS) return result;
    excerptLimit -= Math.max(1_000, result.length - MAX_EVIDENCE_CHARS + 500);
  }
  return JSON.stringify({
    schemaVersion: IMPROVEMENT_ASSESSMENT_EVIDENCE_VERSION,
    truncated: true,
    originalChars: text.length,
    evidenceExcerpt: boundedText(text, 1_000),
  });
}
