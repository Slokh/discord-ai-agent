import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config/env.js";
import { createPool } from "../src/db/pool.js";
import { createAppDatabase } from "../src/db/repositories.js";
import { AgentRuntimeRepository } from "../src/db/agentRuntimeRepository.js";
import { DeliveryObligationsRepository } from "../src/db/deliveryObligationsRepository.js";
import type { ImprovementCase, ImprovementCaseStatus, ImprovementClassification, ImprovementContractCheck, ImprovementSeverity } from "../src/db/types.js";
import { improvementFingerprint } from "../src/improvements/coalescing.js";
import {
  recordAutomatedImprovementDetection,
  type AutomatedImprovementSource,
} from "../src/improvements/detections.js";
import {
  buildImprovementTriageDossier,
  collectImprovementRuntimeObservations,
  improvementTriageApplication,
  type ImprovementTriageVerdict,
} from "../src/improvements/triage.js";
import { fetchGitHubPullRequestSnapshot } from "../src/github/pullRequests.js";
import { reconcileImprovementPullRequestWork } from "../src/improvements/work.js";
import { runImprovementReconciliationOnce } from "../src/improvements/reconciler.js";

const args = process.argv.slice(2);
const target = option("--target");
if (target !== "local" && target !== "production") fail("Pass --target local or --target production.");
if (target === "production" && !args.includes("--confirm-production")) fail("Production writes and reads require --confirm-production.");
if (target === "local" && process.env.NODE_ENV === "production") fail("Refusing --target local while NODE_ENV=production.");

const command = positional(0);
if (!command) fail(usage());
const config = loadConfig();
assertDatabaseTarget(target, config.databaseUrl);
const pool = createPool(config);
const repo = createAppDatabase(pool);

try {
  if (command === "inbox") {
    const statuses = repeated("--status").map(statusValue);
    print(await repo.listImprovementCases({ statuses, limit: numberOption("--limit", 100) }));
  } else if (command === "show") {
    const result = await repo.getImprovementCase(requiredPositional(1, "case id"));
    if (!result) fail("Improvement case not found.");
    print(result);
  } else if (command === "suggest") {
    print(await repo.suggestImprovementCaseMerges({ caseId: requiredPositional(1, "case id"), limit: numberOption("--limit", 10) }));
  } else if (command === "triage") {
    const caseId = requiredPositional(1, "case id");
    const record = await repo.getImprovementCase(caseId);
    if (!record) fail("Improvement case not found.");
    const runtime = await collectImprovementRuntimeObservations(record.signals, {
      runtime: new AgentRuntimeRepository(pool),
      deliveries: new DeliveryObligationsRepository(pool),
    });
    const dossier = buildImprovementTriageDossier(record, runtime);
    if (!args.includes("--apply")) {
      print(dossier);
    } else {
      const checkValues = repeated("--check");
      const application = improvementTriageApplication(dossier, {
        verdict: option("--verdict") ? triageVerdict(option("--verdict")!) : undefined,
        evidenceSummary: option("--evidence-summary"),
        expectedBehavior: option("--expected"),
        checks: checkValues.length ? checkValues.map(parseCheck) : undefined,
        classification: option("--classification") ? classificationValue(option("--classification")!) : undefined,
        severity: option("--severity") ? severityValue(option("--severity")!) : undefined,
        owningDomain: option("--domain"),
      });
      print({ dossier, result: await repo.applyImprovementTriage({ ...application, actorId: process.env.USER ?? "operator" }) });
    }
  } else if (command === "report") {
    const summary = requiredOption("--summary");
    const classification = classificationValue(option("--classification") ?? "unknown");
    const severity = severityValue(option("--severity") ?? "medium");
    const owningDomain = option("--domain");
    const fingerprint = improvementFingerprint({
      scope: "repository", privacy: publicationSafe() ? "publication_safe" : "private",
      owningDomain, classification, summary, stableCode: option("--stable-code"),
    });
    print(await repo.recordImprovementSignal({
      source: "operator_report",
      sourceKey: option("--source-key") ?? `operator:${randomUUID()}`,
      reporterKind: "operator",
      reporterId: process.env.USER ?? "operator",
      scope: "repository",
      privacy: publicationSafe() ? "publication_safe" : "private",
      summary,
      details: option("--details"),
      classification,
      severity,
      owningDomain,
      fingerprint,
      appRevision: config.appRevision,
    }));
  } else if (command === "detect") {
    const recorded = await recordAutomatedImprovementDetection(repo, {
      source: automatedDetectionSource(requiredOption("--source")),
      sourceId: requiredOption("--source-id"),
      stableCode: requiredOption("--stable-code"),
      summary: requiredOption("--summary"),
      classification: classificationValue(requiredOption("--classification")),
      severity: severityValue(requiredOption("--severity")),
      owningDomain: requiredOption("--domain"),
      scope: improvementScope(option("--scope") ?? "deployment"),
      appRevision: option("--revision") ?? config.appRevision,
    });
    print({
      caseId: recorded.case.caseId,
      signalId: recorded.signal.signalId,
      caseCreated: recorded.caseCreated,
      signalCreated: recorded.signalCreated,
    });
  } else if (command === "transition") {
    print(await repo.transitionImprovementCase({
      caseId: requiredPositional(1, "case id"),
      to: statusValue(requiredPositional(2, "status")),
      actorKind: "operator",
      actorId: process.env.USER ?? "operator",
      classification: option("--classification") ? classificationValue(option("--classification")!) : undefined,
      severity: option("--severity") ? severityValue(option("--severity")!) : undefined,
      owningDomain: option("--domain"),
      resolution: option("--resolution"),
      expectedVersion: option("--version") ? numberOption("--version", 0) : undefined,
    }));
  } else if (command === "evidence") {
    print(await repo.addImprovementEvidence({
      caseId: requiredPositional(1, "case id"),
      kind: requiredOption("--kind"),
      disposition: evidenceDisposition(requiredOption("--disposition")),
      summary: requiredOption("--summary"),
      referenceType: option("--reference-type"),
      referenceId: option("--reference-id"),
      privacy: publicationSafe() ? "publication_safe" : "private",
      actorId: process.env.USER ?? "operator",
    }));
  } else if (command === "contract") {
    const checks = repeated("--check").map(parseCheck);
    print(await repo.acceptImprovementContract({
      caseId: requiredPositional(1, "case id"),
      expectedBehavior: requiredOption("--expected"),
      checks,
      sourceRevision: option("--revision") ?? config.appRevision,
      createdBy: process.env.USER ?? "operator",
    }));
  } else if (command === "verify") {
    const caseId = requiredPositional(1, "case id");
    const revision = requiredOption("--revision");
    const verificationInput = {
      caseId,
      revision,
      deploymentId: option("--deployment-id"),
    };
    const dossier = await repo.inspectImprovementVerification(verificationInput);
    print(args.includes("--apply")
      ? { dossier, result: await repo.verifyImprovementCase({ ...verificationInput, actorId: process.env.USER ?? "operator" }) }
      : dossier);
  } else if (command === "link-task") {
    print(await repo.linkImprovementCaseTask({
      caseId: requiredPositional(1, "case id"), taskId: requiredOption("--task"), actorId: process.env.USER ?? "operator",
    }));
  } else if (command === "link-pr") {
    const pullRequest = await fetchGitHubPullRequestSnapshot(config, requiredOption("--pr"));
    print(await repo.linkImprovementCasePullRequest({
      caseId: requiredPositional(1, "case id"), pullRequest, actorId: process.env.USER ?? "operator",
    }));
  } else if (command === "sync-prs") {
    print(await reconcileImprovementPullRequestWork(repo, config, process.env.USER ?? "operator"));
  } else if (command === "reconcile") {
    print(await runImprovementReconciliationOnce({
      repo,
      config,
      runtime: new AgentRuntimeRepository(pool),
      deliveries: new DeliveryObligationsRepository(pool),
    }));
  } else if (command === "merge") {
    await repo.mergeImprovementCases({
      sourceCaseId: requiredPositional(1, "source case id"),
      targetCaseId: requiredPositional(2, "target case id"),
      actorId: process.env.USER ?? "operator",
    });
    print({ merged: requiredPositional(1, "source case id"), into: requiredPositional(2, "target case id") });
  } else {
    fail(usage());
  }
} finally {
  await pool.end();
}

function option(name: string) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
function repeated(name: string) { return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []); }
function positionals() { const values: string[] = []; for (let i = 0; i < args.length; i += 1) { if (args[i]?.startsWith("--")) { if (!["--confirm-production", "--publication-safe", "--apply"].includes(args[i]!)) i += 1; } else values.push(args[i]!); } return values; }
function positional(index: number) { return positionals()[index]; }
function requiredPositional(index: number, name: string) { const value = positional(index); if (!value) fail(`Missing ${name}.`); return value; }
function requiredOption(name: string) { const value = option(name); if (!value) fail(`Missing ${name}.`); return value; }
function publicationSafe() { return args.includes("--publication-safe"); }
function numberOption(name: string, fallback: number) { const value = Number(option(name) ?? fallback); if (!Number.isFinite(value)) fail(`${name} must be a number.`); return Math.trunc(value); }
function statusValue(value: string): ImprovementCaseStatus { const values: ImprovementCaseStatus[] = ["open", "needs_evidence", "actionable", "in_progress", "verifying", "resolved", "dismissed"]; if (!values.includes(value as ImprovementCaseStatus)) fail(`Invalid status: ${value}`); return value as ImprovementCaseStatus; }
function classificationValue(value: string): ImprovementClassification { const values: ImprovementClassification[] = ["unknown", "defect", "product_gap", "data_quality", "developer_friction", "external_incident", "expected_behavior"]; if (!values.includes(value as ImprovementClassification)) fail(`Invalid classification: ${value}`); return value as ImprovementClassification; }
function severityValue(value: string): ImprovementSeverity { const values: ImprovementSeverity[] = ["low", "medium", "high", "critical"]; if (!values.includes(value as ImprovementSeverity)) fail(`Invalid severity: ${value}`); return value as ImprovementSeverity; }
function automatedDetectionSource(value: string): AutomatedImprovementSource { const values: AutomatedImprovementSource[] = ["runtime_detection", "deployment_detection", "ci_detection", "eval_detection"]; if (!values.includes(value as AutomatedImprovementSource)) fail(`Invalid automated detection source: ${value}`); return value as AutomatedImprovementSource; }
function improvementScope(value: string): ImprovementCase["scope"] { const values: ImprovementCase["scope"][] = ["guild", "repository", "deployment", "global"]; if (!values.includes(value as ImprovementCase["scope"])) fail(`Invalid improvement scope: ${value}`); return value as ImprovementCase["scope"]; }
function triageVerdict(value: string): ImprovementTriageVerdict { const values: ImprovementTriageVerdict[] = ["confirmed", "not_reproduced", "insufficient_evidence"]; if (!values.includes(value as ImprovementTriageVerdict)) fail(`Invalid triage verdict: ${value}`); return value as ImprovementTriageVerdict; }
function evidenceDisposition(value: string) { if (value !== "supports" && value !== "contradicts" && value !== "inconclusive") fail(`Invalid evidence disposition: ${value}`); return value; }
function parseCheck(value: string): ImprovementContractCheck { try { const parsed = JSON.parse(value) as ImprovementContractCheck; if (!parsed || typeof parsed !== "object" || typeof parsed.kind !== "string") throw new Error(); return parsed; } catch { fail(`Invalid --check JSON: ${value}`); } }
function print(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function fail(message: string): never { throw new Error(message); }
function assertDatabaseTarget(selected: "local" | "production", databaseUrl: string) { const host = new URL(databaseUrl).hostname; const local = ["localhost", "127.0.0.1", "::1", "postgres"].includes(host); if (selected === "local" && !local) fail(`Refusing --target local for database host ${host}.`); if (selected === "production" && (process.env.NODE_ENV !== "production" || local)) fail("Production target requires NODE_ENV=production and a non-local database host."); }
function usage() { return "Usage: npm run improve -- --target local|production [--confirm-production] inbox|show|suggest|triage|report|detect|transition|evidence|contract|link-task|link-pr|sync-prs|reconcile|verify|merge ..."; }
