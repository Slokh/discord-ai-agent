import type { ObservedSandboxRun } from "./backend.js";

export type SandboxFailureDiagnosis = {
  code:
    | "sandbox_oom"
    | "sandbox_evicted"
    | "sandbox_deadline"
    | "sandbox_start_failed"
    | "sandbox_runner_crash"
    | "sandbox_disappeared"
    | "sandbox_unknown";
  category: "sandbox_resource" | "harness_startup" | "unknown";
  summary: string;
  nextAction: string;
  diagnosticsStatus: string;
};

export function diagnoseObservedSandboxFailure(observed: ObservedSandboxRun): SandboxFailureDiagnosis {
  const metadata = observed.metadata ?? {};
  const jobReason = stringValue(metadata.jobFailureReason) || observed.reason || "";
  const podReason = stringValue(metadata.podReason);
  const containerReason = stringValue(metadata.containerReason);
  const exitCode = numberValue(metadata.exitCode);
  const diagnosticsStatus = stringValue(metadata.diagnosticsStatus) || "unavailable";
  const combinedReason = `${jobReason} ${podReason} ${containerReason}`;

  if (/deadlineexceeded/i.test(combinedReason)) {
    return diagnosis(
      "sandbox_deadline",
      "sandbox_resource",
      "The coding workspace exceeded its execution limit.",
      diagnosticsStatus,
    );
  }
  if (/oomkilled|out of memory/i.test(combinedReason) || exitCode === 137) {
    return diagnosis(
      "sandbox_oom",
      "sandbox_resource",
      "The coding workspace ran out of memory during implementation.",
      diagnosticsStatus,
    );
  }
  if (/evicted|preempt|nodeshutdown|shutdown/i.test(combinedReason)) {
    return diagnosis(
      "sandbox_evicted",
      "sandbox_resource",
      "The cluster interrupted the coding workspace during implementation.",
      diagnosticsStatus,
    );
  }
  if (/imagepull|errimage|createcontainer|containercannotrun|invalidimagename/i.test(combinedReason)) {
    return diagnosis(
      "sandbox_start_failed",
      "harness_startup",
      "The coding workspace could not start.",
      diagnosticsStatus,
    );
  }
  if (observed.status === "gone") {
    return diagnosis(
      "sandbox_disappeared",
      "unknown",
      "The coding workspace disappeared before it could report a result.",
      diagnosticsStatus,
    );
  }
  if (exitCode != null || containerReason) {
    return diagnosis(
      "sandbox_runner_crash",
      "unknown",
      "The coding workspace stopped unexpectedly during implementation.",
      diagnosticsStatus,
    );
  }
  return diagnosis(
    "sandbox_unknown",
    "unknown",
    "The coding workspace stopped unexpectedly during implementation.",
    diagnosticsStatus,
  );
}

function diagnosis(
  code: SandboxFailureDiagnosis["code"],
  category: SandboxFailureDiagnosis["category"],
  summary: string,
  diagnosticsStatus: string,
): SandboxFailureDiagnosis {
  return {
    code,
    category,
    summary,
    nextAction: "React with 🔄 to retry the code change.",
    diagnosticsStatus,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
