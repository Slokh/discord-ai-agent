import { createHash } from "node:crypto";
import type { ImprovementCaseStatus, ImprovementContractCheck, ImprovementPrivacy } from "../db/types.js";

export type ImprovementVerificationStatus = "passed" | "failed" | "inconclusive";
export type ImprovementVerificationProofSource = "private_eval" | "revision_quality" | "release_ci" | "deployment" | "runtime_ledger" | "unavailable";

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
  source: "private_eval" | "revision_quality";
  referenceType: string;
  referenceId: string;
  summary: string;
  createdAt: Date;
};

export type ImprovementVerificationExecution = {
  executionId: string;
  revision: string;
  status: string;
  observedTools: string[];
  eventNames: string[];
  deliveryState: string | null;
  responseText: string | null;
};

export type ImprovementVerificationCheckResult = {
  index: number;
  checkHash: string;
  check: ImprovementContractCheck;
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
  applicationKey: string;
  nextAction: "apply" | "collect_proof";
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

const TERMINAL_EXECUTIONS = new Set(["succeeded", "failed", "no_changes", "cancelled"]);
const KNOWN_EVALS = new Set(["private-regression-suite"]);
const KNOWN_CANARIES = new Set([
  "post-deploy-deployment_health",
  "post-deploy-capability_canary",
  "post-deploy-stability",
  "post-deploy-promotion",
]);

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
  execution: ImprovementVerificationExecution | null;
}): ImprovementVerificationDossier {
  const deploymentCurrent = Boolean(input.deploymentVerifiedAt && input.contract.createdAt <= input.deploymentVerifiedAt);
  const checks = input.contract.checks.map((check, index) => evaluateCheck({
    check,
    index,
    revision: input.revision,
    deploymentId: input.deploymentId,
    deploymentCurrent,
    proofs: input.proofs,
    execution: input.execution,
  }));
  const status = overallStatus(checks);
  const applicationKey = improvementVerificationApplicationKey({
    caseId: input.improvementCase.caseId,
    contractId: input.contract.contractId,
    contractVersion: input.contract.version,
    revision: input.revision,
    deploymentId: input.deploymentId,
    executionId: input.execution?.executionId ?? null,
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
    executionId: input.execution?.executionId ?? null,
    status,
    checks,
    applicationKey,
    nextAction: status === "inconclusive" ? "collect_proof" : "apply",
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
  execution: ImprovementVerificationExecution | null;
}): ImprovementVerificationCheckResult {
  const base = { index: input.index, checkHash: hashJson(input.check), check: input.check };
  if (!input.deploymentCurrent) {
    return result(base, "inconclusive", "unavailable", "The requested revision has no verified deployment newer than this contract.");
  }
  if (input.execution && input.execution.revision !== input.revision) {
    return result(base, "inconclusive", "runtime_ledger", "The supplied execution belongs to a different application revision.", "agent_runtime_execution", input.execution.executionId);
  }
  if (input.execution && !TERMINAL_EXECUTIONS.has(input.execution.status)) {
    return result(base, "inconclusive", "runtime_ledger", "The supplied execution is not terminal.", "agent_runtime_execution", input.execution.executionId);
  }
  if (input.execution && input.execution.status !== "succeeded") {
    return result(base, "failed", "runtime_ledger", "The supplied terminal execution did not succeed.", "agent_runtime_execution", input.execution.executionId);
  }

  if (input.check.kind === "tool") {
    if (input.execution) {
      const observed = input.execution.observedTools.includes(input.check.name);
      const passed = input.check.expectation === "required" ? observed : !observed;
      return result(base, passed ? "passed" : "failed", "runtime_ledger", passed ? "The terminal execution satisfied the tool assertion." : "The terminal execution violated the tool assertion.", "agent_runtime_execution", input.execution.executionId);
    }
    return evalResult(base, input.proofs.find((proof) => proof.source === "private_eval") ?? null);
  }
  if (input.check.kind === "answer_text") {
    if (input.execution) {
      if (input.execution.responseText == null) return result(base, "inconclusive", "runtime_ledger", "The terminal execution has no retained response artifact.", "agent_runtime_execution", input.execution.executionId);
      const contains = input.execution.responseText.toLowerCase().includes(input.check.value.toLowerCase());
      const passed = input.check.expectation === "required" ? contains : !contains;
      return result(base, passed ? "passed" : "failed", "runtime_ledger", passed ? "The retained response satisfied the text assertion." : "The retained response violated the text assertion.", "agent_runtime_execution", input.execution.executionId);
    }
    return evalResult(base, input.proofs.find((proof) => proof.source === "private_eval") ?? null);
  }
  if (input.check.kind === "runtime_event") {
    if (!input.execution) return result(base, "inconclusive", "unavailable", "This runtime-event assertion requires --execution-id.");
    const observed = input.execution.eventNames.includes(input.check.name);
    const passed = input.check.expectation === "required" ? observed : !observed;
    return result(base, passed ? "passed" : "failed", "runtime_ledger", passed ? "The terminal execution satisfied the runtime-event assertion." : "The terminal execution violated the runtime-event assertion.", "agent_runtime_execution", input.execution.executionId);
  }
  if (input.check.kind === "delivery_state") {
    if (!input.execution) return result(base, "inconclusive", "unavailable", "This delivery assertion requires --execution-id.");
    const passed = input.execution.deliveryState === input.check.state;
    return result(base, passed ? "passed" : "failed", "runtime_ledger", passed ? "The durable delivery obligation reached the required state." : "The durable delivery obligation did not reach the required state.", "agent_runtime_execution", input.execution.executionId);
  }
  if (input.check.kind === "eval") {
    if (!KNOWN_EVALS.has(input.check.reference)) return result(base, "inconclusive", "unavailable", "No trusted eval adapter owns this reference.");
    return result(base, "passed", "deployment", "The verified deployment passed the private regression stage.", "deployment_verification", input.deploymentId);
  }
  if (input.check.kind === "deployment_canary") {
    if (input.check.reference === "revision-quality-gate") {
      const proof = input.proofs.find((candidate) => candidate.source === "revision_quality");
      if (!proof) return result(base, "inconclusive", "unavailable", "The deployed revision has not completed its traffic-sampled quality gate.");
      return result(base, proof.status, "revision_quality", proof.summary, proof.referenceType, proof.referenceId);
    }
    if (!KNOWN_CANARIES.has(input.check.reference)) return result(base, "inconclusive", "unavailable", "No trusted deployment adapter owns this reference.");
    return result(base, "passed", "deployment", "The release reached durable promotion after all post-deploy gates passed.", "deployment_verification", input.deploymentId);
  }
  if (input.check.kind === "test") {
    return result(base, "passed", "release_ci", "The deployed revision passed the trusted repository test gate.", "deployment_revision", input.revision);
  }
  if (input.check.kind === "database_invariant") {
    return result(base, "passed", "release_ci", "The deployed revision passed the trusted database verification gate.", "deployment_revision", input.revision);
  }
  return result(base, "inconclusive", "unavailable", "Manual checks cannot produce automatic deployment proof.");
}

function evalResult(
  base: { index: number; checkHash: string; check: ImprovementContractCheck },
  proof: ImprovementVerificationProof | null,
) {
  if (!proof) return result(base, "inconclusive", "unavailable", "No case-specific private replay proof was retained for this deployment.");
  return result(base, proof.status, "private_eval", proof.summary, proof.referenceType, proof.referenceId);
}

function result(
  base: { index: number; checkHash: string; check: ImprovementContractCheck },
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

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
