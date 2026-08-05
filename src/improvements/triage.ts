import { createHash } from "node:crypto";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DeliveryObligationsRepository } from "../db/deliveryObligationsRepository.js";
import type {
  ImprovementCase,
  ImprovementCaseStatus,
  ImprovementClassification,
  ImprovementContractCheck,
  ImprovementPrivacy,
  ImprovementSeverity,
  ImprovementSignal,
  ImprovementSignalSource,
} from "../db/types.js";
import { assertActionableContract } from "./policy.js";
import { isRevisionQualityClusterReference } from "./proofAdapters.js";

export type ImprovementTriageVerdict = "confirmed" | "not_reproduced" | "insufficient_evidence";

export type ImprovementRuntimeObservation = {
  executionId: string;
  status: string;
  warningEvents: number;
  errorEvents: number;
  failedToolCalls: number;
  deliveryState: "pending" | "delivered" | "abandoned" | null;
  durationMs: number | null;
  failureEventNames: string[];
};

export type ImprovementTriageEvidenceDraft = {
  signalId?: string | null;
  kind: string;
  disposition: "supports" | "contradicts" | "inconclusive";
  summary: string;
  referenceType?: string | null;
  referenceId?: string | null;
  collectedByExecutionId?: string | null;
  privacy: ImprovementPrivacy;
  metadata?: Record<string, unknown>;
};

export type ImprovementTriageContractDraft = {
  expectedBehavior: string;
  checks: ImprovementContractCheck[];
  sourceRevision: string | null;
};

export type ImprovementTriageDossier = {
  case: {
    caseId: string;
    version: number;
    status: ImprovementCaseStatus;
    title: string;
  };
  snapshotKey: string;
  verdict: Exclude<ImprovementTriageVerdict, "not_reproduced">;
  reason: string;
  suggested: {
    classification: ImprovementClassification;
    severity: ImprovementSeverity;
    owningDomain: string | null;
  };
  signalCount: number;
  signals: Array<{
    signalId: string;
    source: ImprovementSignalSource;
    appRevision: string | null;
    referenceType: string | null;
    referenceId: string | null;
  }>;
  runtime: ImprovementRuntimeObservation[];
  evidence: ImprovementTriageEvidenceDraft[];
  proposedContract: ImprovementTriageContractDraft | null;
  nextAction: "apply" | "collect_evidence";
};

export type ImprovementTriageApplication = {
  caseId: string;
  expectedVersion: number;
  snapshotKey: string;
  applicationKey: string;
  verdict: ImprovementTriageVerdict;
  targetStatus: "needs_evidence" | "actionable" | "dismissed";
  classification: ImprovementClassification;
  severity: ImprovementSeverity;
  owningDomain: string | null;
  evidence: ImprovementTriageEvidenceDraft[];
  contract: ImprovementTriageContractDraft | null;
  resolution: string | null;
};

type ImprovementCaseRecord = {
  case: ImprovementCase;
  signals: ImprovementSignal[];
};

type RuntimeReader = Pick<AgentRuntimeRepository, "getExecution" | "listEvents">;
type DeliveryReader = Pick<DeliveryObligationsRepository, "getByExecutionId">;

const AUTOMATED_SOURCES = new Set<ImprovementSignalSource>([
  "runtime_detection",
  "deployment_detection",
  "ci_detection",
  "eval_detection",
]);
const FAILURE_STATUSES = new Set(["failed", "cancelled", "timed_out"]);
const SEVERITY_ORDER: ImprovementSeverity[] = ["low", "medium", "high", "critical"];

/** Reads only content-free execution, event, tool, timing, and delivery aggregates for signal-linked runs. */
export async function collectImprovementRuntimeObservations(
  signals: readonly ImprovementSignal[],
  readers: { runtime: RuntimeReader; deliveries: DeliveryReader },
): Promise<ImprovementRuntimeObservation[]> {
  const executionIds = [...new Set(signals.flatMap((signal) => signal.active && signal.executionId ? [signal.executionId] : []))];
  return Promise.all(executionIds.map(async (executionId) => {
    const execution = await readers.runtime.getExecution({ executionId });
    if (!execution) {
      return {
        executionId,
        status: "missing",
        warningEvents: 0,
        errorEvents: 0,
        failedToolCalls: 0,
        deliveryState: null,
        durationMs: null,
        failureEventNames: [],
      };
    }
    const [events, delivery] = await Promise.all([
      readers.runtime.listEvents({ sessionId: execution.sessionId, executionId, limit: 1_000 }),
      readers.deliveries.getByExecutionId(executionId),
    ]);
    const terminalTools = new Map<string, { status: string; eventName: string }>();
    for (const event of events) {
      if (event.eventName !== "agent.tool.complete") continue;
      const toolName = textValue(event.metadata.toolName) ?? "unknown";
      terminalTools.set(toolName, {
        status: textValue(event.metadata.status) ?? "ok",
        eventName: event.eventName,
      });
    }
    const failedToolCalls = [...terminalTools.values()].filter((tool) => !successfulToolStatus(tool.status)).length;
    const failureEventNames = [...new Set([
      ...events.flatMap((event) => event.level === "error" ? [event.eventName] : []),
      ...(failedToolCalls > 0 ? ["agent.tool.complete"] : []),
    ])].slice(0, 20);
    return {
      executionId,
      status: execution.status,
      warningEvents: events.filter((event) => event.level === "warn").length,
      errorEvents: events.filter((event) => event.level === "error").length,
      failedToolCalls,
      deliveryState: delivery?.state ?? null,
      durationMs: execution.startedAt && execution.completedAt
        ? Math.max(0, execution.completedAt.getTime() - execution.startedAt.getTime())
        : null,
      failureEventNames,
    };
  }));
}

/** Builds a content-minimized operator dossier from durable signal provenance and runtime aggregates. */
export function buildImprovementTriageDossier(
  record: ImprovementCaseRecord,
  runtimeObservations: readonly ImprovementRuntimeObservation[],
): ImprovementTriageDossier {
  if (record.case.mergedIntoCaseId) throw new Error(`Improvement case ${record.case.caseId} was merged and cannot be triaged.`);
  const signals = record.signals.filter((signal) => signal.active);
  const runtime = uniqueRuntime(runtimeObservations, signals);
  const runtimeByExecution = new Map(runtime.map((observation) => [observation.executionId, observation]));
  const hasAutomatedFailure = signals.some((signal) => AUTOMATED_SOURCES.has(signal.source));
  const hasObservedRuntimeFailure = runtime.some(runtimeFailure);
  const verdict = hasAutomatedFailure || hasObservedRuntimeFailure ? "confirmed" : "insufficient_evidence";
  const reason = hasAutomatedFailure
    ? "A trusted automated observer recorded a terminal gate failure."
    : hasObservedRuntimeFailure
      ? "Retained runtime aggregates contain a terminal execution, tool, event, or delivery failure."
      : "The retained references establish a report, but not an independently confirmed failure.";
  const evidence = signals.map((signal) => evidenceForSignal(signal, runtimeByExecution.get(signal.executionId ?? "")));
  if (evidence.length === 0) {
    evidence.push({
      kind: "signal_state",
      disposition: "inconclusive",
      summary: "The case currently has no active source signals to assess.",
      referenceType: "improvement_case",
      referenceId: record.case.caseId,
      privacy: record.case.privacy,
    });
  }
  const proposedContract = verdict === "confirmed" ? contractForFailures(signals, runtime) : null;
  const suggested = suggestedOwnership(record.case, signals);

  return {
    case: {
      caseId: record.case.caseId,
      version: record.case.version,
      status: record.case.status,
      title: record.case.title,
    },
    snapshotKey: improvementTriageSnapshotKey(record.case.caseId, signals),
    verdict,
    reason,
    suggested,
    signalCount: signals.length,
    signals: signals.map((signal) => ({
      signalId: signal.signalId,
      source: signal.source,
      appRevision: signal.appRevision,
      ...signalReference(signal),
    })),
    runtime,
    evidence,
    proposedContract,
    nextAction: verdict === "confirmed" && proposedContract ? "apply" : "collect_evidence",
  };
}

/** Converts a reviewed dossier into one atomic repository mutation. */
export function improvementTriageApplication(
  dossier: ImprovementTriageDossier,
  decision: {
    verdict?: ImprovementTriageVerdict;
    evidenceSummary?: string | null;
    expectedBehavior?: string | null;
    checks?: ImprovementContractCheck[] | null;
    classification?: ImprovementClassification;
    severity?: ImprovementSeverity;
    owningDomain?: string | null;
    assessmentKind?: "operator_assessment" | "agent_assessment";
  } = {},
): ImprovementTriageApplication {
  const verdict = decision.verdict ?? dossier.verdict;
  const verdictChanged = verdict !== dossier.verdict;
  const evidenceSummary = boundedText(decision.evidenceSummary, 4_000);
  if (verdictChanged && !evidenceSummary) {
    throw new Error("An explicit evidence summary is required when overriding the triage verdict.");
  }
  const evidence = [...dossier.evidence];
  if (evidenceSummary) {
    evidence.push({
      kind: decision.assessmentKind ?? "operator_assessment",
      disposition: verdict === "confirmed" ? "supports" : verdict === "not_reproduced" ? "contradicts" : "inconclusive",
      summary: evidenceSummary,
      referenceType: "improvement_case",
      referenceId: dossier.case.caseId,
      privacy: dossier.evidence[0]?.privacy ?? "private",
    });
  }

  let contract: ImprovementTriageContractDraft | null = null;
  if (verdict === "confirmed") {
    const expectedBehavior = boundedText(decision.expectedBehavior, 4_000)
      ?? dossier.proposedContract?.expectedBehavior
      ?? null;
    const checks = decision.checks ?? dossier.proposedContract?.checks ?? [];
    if (!expectedBehavior) throw new Error("A confirmed triage requires expected behavior.");
    assertActionableContract(checks);
    contract = {
      expectedBehavior,
      checks,
      sourceRevision: dossier.proposedContract?.sourceRevision ?? dossier.signals.find((signal) => signal.appRevision)?.appRevision ?? null,
    };
  }

  const application: Omit<ImprovementTriageApplication, "applicationKey"> = {
    caseId: dossier.case.caseId,
    expectedVersion: dossier.case.version,
    snapshotKey: dossier.snapshotKey,
    verdict,
    targetStatus: verdict === "confirmed" ? "actionable" : verdict === "not_reproduced" ? "dismissed" : "needs_evidence",
    classification: decision.classification ?? dossier.suggested.classification,
    severity: decision.severity ?? dossier.suggested.severity,
    owningDomain: decision.owningDomain === undefined ? dossier.suggested.owningDomain : boundedText(decision.owningDomain, 100),
    evidence,
    contract,
    resolution: verdict === "not_reproduced" ? `Not reproduced: ${evidenceSummary}` : null,
  };
  return {
    ...application,
    applicationKey: improvementTriageApplicationKey(application),
  };
}

function evidenceForSignal(
  signal: ImprovementSignal,
  runtime: ImprovementRuntimeObservation | undefined,
): ImprovementTriageEvidenceDraft {
  if (AUTOMATED_SOURCES.has(signal.source)) {
    const code = detectionCode(signal);
    const revision = signal.appRevision ? ` for revision ${signal.appRevision}` : "";
    return {
      signalId: signal.signalId,
      kind: automatedEvidenceKind(signal.source),
      disposition: "supports",
      summary: `${sourceLabel(signal.source)} recorded terminal failure ${code}${revision}.`,
      referenceType: "improvement_signal",
      referenceId: signal.signalId,
      privacy: signal.privacy,
      metadata: { detectionCode: code },
    };
  }
  if (runtime) {
    const failure = runtimeFailure(runtime);
    return {
      signalId: signal.signalId,
      kind: "runtime_trace",
      disposition: failure ? "supports" : "inconclusive",
      summary: runtimeSummary(runtime),
      referenceType: "agent_runtime_execution",
      referenceId: runtime.executionId,
      collectedByExecutionId: runtime.status === "missing" ? null : runtime.executionId,
      privacy: signal.privacy,
      metadata: {
        status: runtime.status,
        warningEvents: runtime.warningEvents,
        errorEvents: runtime.errorEvents,
        failedToolCalls: runtime.failedToolCalls,
        deliveryState: runtime.deliveryState,
        durationMs: runtime.durationMs,
        failureEventNames: runtime.failureEventNames,
      },
    };
  }
  const reference = signalReference(signal);
  return {
    signalId: signal.signalId,
    kind: "source_report",
    disposition: "inconclusive",
    summary: `${sourceLabel(signal.source)} exists, but its retained reference does not independently establish the reported behavior.`,
    referenceType: reference.referenceType ?? "improvement_signal",
    referenceId: reference.referenceId ?? signal.signalId,
    privacy: signal.privacy,
  };
}

function contractForFailures(
  signals: ImprovementSignal[],
  runtime: ImprovementRuntimeObservation[],
): ImprovementTriageContractDraft | null {
  const checks: ImprovementContractCheck[] = [];
  let unmappedAutomatedFailure = false;
  for (const signal of signals) {
    const reference = detectionCode(signal);
    if (signal.source === "eval_detection" && reference === "private-regression-suite") {
      checks.push({ kind: "eval", reference });
    } else if (signal.source === "ci_detection" && reference === "release-verify") {
      checks.push({ kind: "test", reference });
    } else if (signal.source === "ci_detection" && reference === "release-db-verify") {
      checks.push({ kind: "database_invariant", reference });
    } else if (signal.source === "runtime_detection" && (reference === "revision-quality-gate" || isRevisionQualityClusterReference(reference))) {
      checks.push({ kind: "deployment_canary", reference });
    } else if (signal.source === "deployment_detection" && knownPostDeployGate(reference)) {
      checks.push({ kind: "deployment_canary", reference });
    } else if (AUTOMATED_SOURCES.has(signal.source)) {
      unmappedAutomatedFailure = true;
    }
  }
  if (unmappedAutomatedFailure) return null;
  if (runtime.some(runtimeFailure) && checks.length === 0) {
    const runtimeChecks = contractChecksForRuntime(runtime);
    if (!runtimeChecks) return null;
    checks.push(...runtimeChecks);
  }
  const uniqueChecks = deduplicateChecks(checks);
  if (uniqueChecks.length === 0) return null;
  const sources = new Set(signals.filter((signal) => AUTOMATED_SOURCES.has(signal.source)).map((signal) => signal.source));
  const expectedBehavior = sources.size === 1
    ? expectedBehaviorForSource([...sources][0]!)
    : sources.size > 1
      ? "Every detected automated gate passes for the candidate revision."
      : "The triggering execution path completes without terminal runtime or delivery failures.";
  return {
    expectedBehavior,
    checks: uniqueChecks,
    sourceRevision: signals.find((signal) => signal.appRevision)?.appRevision ?? null,
  };
}

function contractChecksForRuntime(runtime: ImprovementRuntimeObservation[]): ImprovementContractCheck[] | null {
  const checks: ImprovementContractCheck[] = [];
  for (const observation of runtime.filter(runtimeFailure)) {
    const executionFailureCovered = observation.status === "failed";
    if (executionFailureCovered) {
      checks.push({ kind: "runtime_event", name: "agent.execution.failed", expectation: "forbidden" });
    } else if (FAILURE_STATUSES.has(observation.status)) {
      return null;
    }
    if (observation.deliveryState === "abandoned") {
      checks.push({ kind: "delivery_state", state: "delivered" });
    }
    const errorEvents = observation.failureEventNames.filter((name) => name !== "agent.tool.complete");
    checks.push(...errorEvents.map((name): ImprovementContractCheck => ({
      kind: "runtime_event",
      name,
      expectation: "forbidden",
    })));
    if (observation.failedToolCalls > 0 && !executionFailureCovered) return null;
  }
  return deduplicateChecks(checks);
}

function runtimeFailure(observation: ImprovementRuntimeObservation) {
  return FAILURE_STATUSES.has(observation.status)
    || observation.errorEvents > 0
    || observation.failedToolCalls > 0
    || observation.deliveryState === "abandoned";
}

function runtimeSummary(observation: ImprovementRuntimeObservation) {
  const delivery = observation.deliveryState ? `, delivery ${observation.deliveryState}` : "";
  const duration = observation.durationMs == null ? "" : `, ${observation.durationMs}ms duration`;
  return `Retained execution finished ${observation.status} with ${observation.warningEvents} warning events, ${observation.errorEvents} error events, ${observation.failedToolCalls} failed tool calls${delivery}${duration}.`;
}

function uniqueRuntime(observations: readonly ImprovementRuntimeObservation[], signals: ImprovementSignal[]) {
  const referenced = new Set(signals.flatMap((signal) => signal.executionId ? [signal.executionId] : []));
  const seen = new Set<string>();
  return observations.filter((observation) => referenced.has(observation.executionId) && !seen.has(observation.executionId) && Boolean(seen.add(observation.executionId)));
}

function suggestedOwnership(caseRow: ImprovementCase, signals: ImprovementSignal[]) {
  const classification = caseRow.classification !== "unknown"
    ? caseRow.classification
    : signals.find((signal) => signal.classificationHint && signal.classificationHint !== "unknown")?.classificationHint ?? "unknown";
  const severity = signals.reduce((current, signal) => higherSeverity(current, signal.severityHint), caseRow.severity);
  const owningDomain = caseRow.owningDomain ?? signals.find((signal) => signal.owningDomainHint)?.owningDomainHint ?? null;
  return { classification, severity, owningDomain };
}

function higherSeverity(current: ImprovementSeverity, candidate: ImprovementSeverity | null) {
  return candidate && SEVERITY_ORDER.indexOf(candidate) > SEVERITY_ORDER.indexOf(current) ? candidate : current;
}

export function improvementTriageSnapshotKey(caseId: string, signals: readonly ImprovementSignal[]) {
  const source = signals
    .map((signal) => `${signal.signalId}:${signal.sourceKey}:${signal.updatedAt.toISOString()}`)
    .sort()
    .join("\0");
  return createHash("sha256").update(`${caseId}\0${source}`).digest("hex");
}

export function improvementTriageApplicationKey(
  input: Omit<ImprovementTriageApplication, "applicationKey"> | ImprovementTriageApplication,
) {
  return createHash("sha256").update(JSON.stringify({
    caseId: input.caseId,
    snapshotKey: input.snapshotKey,
    verdict: input.verdict,
    targetStatus: input.targetStatus,
    classification: input.classification,
    severity: input.severity,
    owningDomain: input.owningDomain,
    evidence: input.evidence,
    contract: input.contract,
    resolution: input.resolution,
  })).digest("hex");
}

function signalReference(signal: ImprovementSignal) {
  if (signal.executionId) return { referenceType: "agent_runtime_execution", referenceId: signal.executionId };
  if (signal.taskId) return { referenceType: "agent_task", referenceId: signal.taskId };
  if (signal.messageId) return { referenceType: "discord_message", referenceId: signal.messageId };
  if (signal.appRevision) return { referenceType: "application_revision", referenceId: signal.appRevision };
  return { referenceType: null, referenceId: null };
}

function detectionCode(signal: ImprovementSignal) {
  const value = signal.metadata.detectionCode;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : signal.source;
}

function automatedEvidenceKind(source: ImprovementSignalSource) {
  if (source === "eval_detection") return "eval_regression";
  if (source === "runtime_detection") return "runtime_gate";
  if (source === "deployment_detection") return "deployment_gate";
  return "ci_gate";
}

function expectedBehaviorForSource(source: ImprovementSignalSource) {
  if (source === "eval_detection") return "The private regression suite passes for the candidate revision.";
  if (source === "runtime_detection") return "The deployed revision satisfies the production runtime quality policy.";
  if (source === "deployment_detection") return "The candidate revision passes its post-deploy verification gate.";
  return "The trusted main-branch CI check passes for the candidate revision.";
}

function knownPostDeployGate(reference: string) {
  return [
    "post-deploy-deployment_health",
    "post-deploy-capability_canary",
    "post-deploy-stability",
    "post-deploy-promotion",
  ].includes(reference);
}

function sourceLabel(source: ImprovementSignalSource) {
  return source.replaceAll("_", " ");
}

function deduplicateChecks(checks: ImprovementContractCheck[]) {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = JSON.stringify(check);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedText(value: string | null | undefined, max: number) {
  const normalized = value?.replace(/\s+/g, " ").trim().slice(0, max) ?? "";
  return normalized || null;
}

function successfulToolStatus(value: string) {
  return ["ok", "succeeded", "success", "reused"].includes(value);
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
