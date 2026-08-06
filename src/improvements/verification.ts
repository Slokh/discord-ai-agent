import { createHash } from "node:crypto";
import type { ImprovementCaseStatus, ImprovementContractCheck, ImprovementPrivacy } from "../db/types.js";
import {
  improvementCheckHash,
  improvementProofAdapterForCheck,
  type ImprovementProofAdapterId,
  type ImprovementProofTrigger,
} from "./proofAdapters.js";
import type { ImprovementReplayCheckResult } from "../observability/improvementContractReplay.js";

export type ImprovementVerificationStatus = "passed" | "failed" | "inconclusive";
export type ImprovementVerificationProofSource = "private_eval" | "revision_quality" | "schedule_health" | "producer_health" | "release_ci" | "deployment" | "unavailable";

export type ImprovementVerificationContract = {
  contractId: string;
  caseId: string;
  version: number;
  expectedBehavior: string;
  checks: ImprovementContractCheck[];
  executable: boolean;
  createdAt: Date;
};

export type ImprovementVerificationProof = {
  status: ImprovementVerificationStatus;
  source: "private_eval" | "revision_quality" | "schedule_health" | "producer_health";
  referenceType: string;
  referenceId: string;
  summary: string;
  executionId: string | null;
  checkResults: ImprovementReplayCheckResult[];
  createdAt: Date;
};

export type ImprovementVerificationCheckResult = {
  index: number;
  checkHash: string;
  check: ImprovementContractCheck;
  adapterId: ImprovementProofAdapterId | null;
  retryTrigger: ImprovementProofTrigger | null;
  status: ImprovementVerificationStatus;
  proofSource: ImprovementVerificationProofSource;
  summary: string;
  referenceType: string | null;
  referenceId: string | null;
};

export type ImprovementVerificationDossier = {
  case: {
    caseId: string;
    version: number;
    status: ImprovementCaseStatus;
    privacy: ImprovementPrivacy;
    title: string;
  };
  contract: {
    contractId: string;
    version: number;
    expectedBehavior: string;
  };
  deployment: {
    revision: string;
    deploymentId: string;
    verifiedAt: Date | null;
  };
  executionId: string | null;
  status: ImprovementVerificationStatus;
  checks: ImprovementVerificationCheckResult[];
  pendingProofs: Array<{
    adapterId: ImprovementProofAdapterId;
    trigger: ImprovementProofTrigger;
  }>;
  applicationKey: string;
  nextAction: "apply" | "await_proof_producers";
};

export type ImprovementVerificationReceipt = {
  receiptId: string;
  caseId: string;
  contractId: string;
  contractVersion: number;
  revision: string;
  deploymentId: string;
  executionId: string | null;
  status: ImprovementVerificationStatus;
  checks: ImprovementVerificationCheckResult[];
  applicationKey: string;
  evidenceId: string | null;
  applied: boolean;
  actorId: string | null;
  createdAt: Date;
};

export function buildImprovementVerificationDossier(input: {
  improvementCase: {
    caseId: string;
    version: number;
    status: ImprovementCaseStatus;
    privacy: ImprovementPrivacy;
    title: string;
  };
  contract: ImprovementVerificationContract;
  revision: string;
  deploymentId: string;
  deploymentVerifiedAt: Date | null;
  proofs: ImprovementVerificationProof[];
}): ImprovementVerificationDossier {
  const deploymentCurrent = Boolean(input.deploymentVerifiedAt && input.contract.createdAt <= input.deploymentVerifiedAt);
  const checks = input.contract.checks.map((check, index) => evaluateCheck({
    check,
    index,
    revision: input.revision,
    deploymentId: input.deploymentId,
    deploymentCurrent,
    proofs: input.proofs,
  }));
  const status = overallStatus(checks);
  const executionId = input.proofs.find((proof) => proof.source === "private_eval")?.executionId ?? null;
  const pendingProofs = uniquePendingProofs(checks);
  const applicationKey = improvementVerificationApplicationKey({
    caseId: input.improvementCase.caseId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.version,
    revision: input.revision,
    deploymentId: input.deploymentId,
    executionId,
    status,
    checks,
  });
  return {
    case: input.improvementCase,
    contract: {
      contractId: input.contract.contractId,
      version: input.contract.version,
      expectedBehavior: input.contract.expectedBehavior,
    },
    deployment: {
      revision: input.revision,
      deploymentId: input.deploymentId,
      verifiedAt: input.deploymentVerifiedAt,
    },
    executionId,
    status,
    checks,
    pendingProofs,
    applicationKey,
    nextAction: status === "inconclusive" ? "await_proof_producers" : "apply",
  };
}

export function improvementVerificationApplicationKey(input: {
  caseId: string;
  contractId: string;
  contractVersion: number;
  revision: string;
  deploymentId: string;
  executionId: string | null;
  status: ImprovementVerificationStatus;
  checks: ImprovementVerificationCheckResult[];
}) {
  return hashJson(input);
}

function evaluateCheck(input: {
  check: ImprovementContractCheck;
  index: number;
  revision: string;
  deploymentId: string;
  deploymentCurrent: boolean;
  proofs: ImprovementVerificationProof[];
}): ImprovementVerificationCheckResult {
  const adapter = improvementProofAdapterForCheck(input.check);
  const base = {
    index: input.index,
    checkHash: improvementCheckHash(input.check),
    check: input.check,
    adapterId: adapter?.id ?? null,
    retryTrigger: adapter?.trigger ?? null,
  };
  if (!adapter) {
    return result(base, "inconclusive", "unavailable", "No registered proof adapter owns this check.");
  }
  if (!input.deploymentCurrent) {
    return result(base, "inconclusive", "unavailable", "The requested revision has no verified deployment newer than this contract.");
  }
  if (adapter.id === "private_replay") {
    const proof = input.proofs.find((candidate) => candidate.source === "private_eval") ?? null;
    if (!proof) return result(base, "inconclusive", "unavailable", "The post-deploy private replay has not produced this check's proof.");
    const conclusion = proof.checkResults.find((candidate) => candidate.checkHash === base.checkHash);
    if (!conclusion) return result(base, "inconclusive", "private_eval", "The latest private replay did not contain a conclusion for this check.", proof.referenceType, proof.referenceId);
    return result(base, conclusion.status, "private_eval", replaySummary(conclusion.status), proof.referenceType, proof.referenceId);
  }
  if (adapter.id === "revision_quality") {
    const expectedReference = input.check.kind === "deployment_canary" ? input.check.reference : "revision-quality-gate";
    const proof = input.proofs.find((candidate) => candidate.source === "revision_quality" && candidate.referenceId === expectedReference) ?? null;
    if (!proof) return result(base, "inconclusive", "unavailable", "Production observation has not produced this check's traffic-sampled proof.");
    return result(base, proof.status, "revision_quality", proof.summary, proof.referenceType, proof.referenceId);
  }
  if (adapter.id === "schedule_health") {
    const expectedReference = input.check.kind === "schedule_health" ? input.check.reference : "";
    const proof = input.proofs.find((candidate) => candidate.source === "schedule_health" && candidate.referenceId === expectedReference) ?? null;
    if (!proof) return result(base, "inconclusive", "unavailable", "Production observation has not produced schedule-specific recovery proof.");
    return result(base, proof.status, "schedule_health", proof.summary, proof.referenceType, proof.referenceId);
  }
  if (adapter.id === "producer_health") {
    const expectedReference = input.check.kind === "proof_producer_health" ? input.check.reference : "";
    const proof = input.proofs.find((candidate) => candidate.source === "producer_health" && candidate.referenceId === expectedReference) ?? null;
    if (!proof) return result(base, "inconclusive", "unavailable", "The proof producer has not recorded a successful recovery run.");
    return result(base, proof.status, "producer_health", proof.summary, proof.referenceType, proof.referenceId);
  }
  if (adapter.id === "release_verify") {
    return result(base, "passed", "release_ci", "The deployed revision passed the trusted repository verification gate.", "deployment_revision", input.revision);
  }
  if (adapter.id === "release_db_verify") {
    return result(base, "passed", "release_ci", "The deployed revision passed the trusted database verification gate.", "deployment_revision", input.revision);
  }
  if (adapter.id === "private_regression_gate") {
    return result(base, "passed", "deployment", "The verified deployment passed the complete private regression stage.", "deployment_verification", input.deploymentId);
  }
  return result(base, "passed", "deployment", "The release reached durable promotion after the registered post-deploy canary passed.", "deployment_verification", input.deploymentId);
}

function result(
  base: Pick<ImprovementVerificationCheckResult, "index" | "checkHash" | "check" | "adapterId" | "retryTrigger">,
  status: ImprovementVerificationStatus,
  proofSource: ImprovementVerificationProofSource,
  summary: string,
  referenceType: string | null = null,
  referenceId: string | null = null,
): ImprovementVerificationCheckResult {
  return { ...base, status, proofSource, summary, referenceType, referenceId };
}

function overallStatus(checks: ImprovementVerificationCheckResult[]): ImprovementVerificationStatus {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.length > 0 && checks.every((check) => check.status === "passed")) return "passed";
  return "inconclusive";
}

function uniquePendingProofs(checks: ImprovementVerificationCheckResult[]) {
  const seen = new Set<string>();
  return checks.flatMap((check) => {
    if (check.status !== "inconclusive" || !check.adapterId || !check.retryTrigger) return [];
    const key = `${check.adapterId}:${check.retryTrigger}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ adapterId: check.adapterId, trigger: check.retryTrigger }];
  });
}

function replaySummary(status: ImprovementVerificationStatus) {
  if (status === "passed") return "The case-specific private replay passed this check.";
  if (status === "failed") return "The case-specific private replay failed this check.";
  return "The case-specific private replay could not conclude this check.";
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
