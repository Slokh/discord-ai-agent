import type { RecordImprovementSignalInput } from "../db/improvementRepository.js";
import type {
  ImprovementCase,
  ImprovementClassification,
  ImprovementSeverity,
} from "../db/types.js";
import { improvementFingerprint, normalizeImprovementTitle } from "./coalescing.js";
import {
  isAutomatedImprovementSource,
  type AutomatedImprovementSource,
} from "./detectorPolicies.js";

export { AUTOMATED_IMPROVEMENT_SOURCES, type AutomatedImprovementSource } from "./detectorPolicies.js";

export type AutomatedImprovementDetectionInput = {
  source: AutomatedImprovementSource;
  sourceId: string;
  summary: string;
  stableCode: string;
  executionId?: string | null;
  appRevision?: string | null;
  scope?: ImprovementCase["scope"];
  classification: ImprovementClassification;
  severity: ImprovementSeverity;
  owningDomain: string;
  affectedMemberContext?: {
    guildId: string;
    channelId: string;
    messageId: string;
    userId: string;
  } | null;
  metadata?: Record<string, unknown>;
};

type ImprovementSignalRecorder<Result> = {
  recordImprovementSignal(input: RecordImprovementSignalInput): Promise<Result>;
};

const STABLE_IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

/** Builds a content-minimized, private signal for a trusted automated observer. */
export function automatedImprovementSignalInput(
  input: AutomatedImprovementDetectionInput,
): RecordImprovementSignalInput {
  if (!isAutomatedImprovementSource(input.source)) {
    throw new Error(`Invalid automated detection source: ${input.source}.`);
  }
  const sourceId = stableIdentifier(input.sourceId, "sourceId", 300);
  const stableCode = stableIdentifier(input.stableCode, "stableCode", 200);
  const summary = normalizeImprovementTitle(input.summary);
  if (!summary) throw new Error("Automated detection summary is required.");
  const owningDomain = stableIdentifier(input.owningDomain, "owningDomain", 100);
  const scope = input.scope ?? "deployment";
  const metadata = {
    ...(input.metadata ?? {}),
    detectionCode: stableCode,
    ...(input.affectedMemberContext ? { affectedMemberContext: input.affectedMemberContext } : {}),
  };

  return {
    source: input.source,
    sourceKey: `${input.source}:${sourceId}`,
    reporterKind: "automation",
    reporterId: `automation:${input.source}`,
    executionId: input.executionId ?? null,
    appRevision: input.appRevision ?? null,
    scope,
    privacy: "private",
    summary,
    classification: input.classification,
    severity: input.severity,
    owningDomain,
    fingerprint: improvementFingerprint({
      scope,
      privacy: "private",
      owningDomain,
      classification: input.classification,
      summary,
      stableCode,
    }),
    metadata,
  };
}

/** Records through the canonical improvement repository so exact observations are idempotent and related ones coalesce. */
export function recordAutomatedImprovementDetection<Result>(
  recorder: ImprovementSignalRecorder<Result>,
  input: AutomatedImprovementDetectionInput,
) {
  return recorder.recordImprovementSignal(automatedImprovementSignalInput(input));
}

function stableIdentifier(value: string, name: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !STABLE_IDENTIFIER.test(normalized)) {
    throw new Error(`${name} must be a stable identifier containing only letters, numbers, ., _, :, or -.`);
  }
  return normalized;
}
