import { describe, expect, it } from "vitest";
import { deriveOperatorActivity, eventLabel, improvementMilestone, retainOpenImprovementActivity } from "../../src/console/activity.js";

describe("operator activity story projection", () => {
  it("pins active conversations and code work as distinct stories without duplicate executions", () => {
    const result = deriveOperatorActivity({
      executions: [{
        executionId: "execution-prompt", taskId: null, title: "Answer a member", status: "running",
        requestPreview: "What changed?", latestEvent: "agent.model.call.started", hasParent: true,
        startedAt: "2026-08-06T12:00:00.000Z", updatedAt: "2026-08-06T12:02:00.000Z",
      }, {
        executionId: "execution-code", taskId: "task-code", title: "Repository task runtime", status: "running",
        latestEvent: "agent.tool.complete", startedAt: "2026-08-06T12:01:00.000Z", updatedAt: "2026-08-06T12:03:00.000Z",
      }],
      tasks: [{
        taskId: "task-code", title: "Improve the dashboard", status: "running", currentStep: "implementing",
        branchName: "kartik/dashboard", pullRequestUrl: "https://github.com/owner/repo/pull/1",
        startedAt: "2026-08-06T12:01:00.000Z", updatedAt: "2026-08-06T12:03:00.000Z",
      }],
      activity: [], deployments: [],
    });

    expect(result.active).toHaveLength(2);
    expect(result.active[0]).toMatchObject({
      id: "task-task-code", kind: "code_change", category: "product", title: "Improve the dashboard",
      tone: "active", branchName: "kartik/dashboard",
    });
    expect(result.active[0]?.technicalEvents[0]).toMatchObject({ label: "Tool completed" });
    expect(result.active[1]).toMatchObject({
      id: "execution-execution-prompt", kind: "conversation", summary: "What changed?", tone: "active", hasParent: true,
    });
  });

  it("uses the final outcome for story tone even when an intermediate event was an error", () => {
    const result = deriveOperatorActivity({
      executions: [], tasks: [], deployments: [],
      activity: [{
        id: "runtime-session-a", kind: "runtime", title: "Recovered conversation", status: "succeeded",
        occurredAt: "2026-08-06T12:05:00.000Z", startedAt: "2026-08-06T12:00:00.000Z",
        durationMs: 300_000, attempts: 2, deliveryState: "delivered",
        events: [
          { id: "2", name: "agent.nanocodex.complete", level: "info", createdAt: "2026-08-06T12:05:00.000Z" },
          { id: "1", name: "agent.model.call.failed", level: "error", createdAt: "2026-08-06T12:01:00.000Z" },
        ],
      }],
    });

    expect(result.recent[0]).toMatchObject({
      kind: "conversation", category: "product", tone: "success", summary: "Reply delivered",
      latencyTone: "very_slow",
    });
    expect(result.recent[0]?.technicalEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "error", label: "Model call failed" }),
    ]));
  });

  it("separates generation from authoritative Discord delivery outcomes", () => {
    const activity = [
      { id: "delivered", deliveryState: "delivered", hasParent: true },
      { id: "pending", deliveryState: "pending" },
      { id: "abandoned", deliveryState: "abandoned" },
      { id: "unobserved" },
      { id: "partial", deliveryState: "delivered", responseStatus: "partial" },
      { id: "failed", deliveryState: "delivered" },
    ].map((item, index) => ({
      ...item, kind: "runtime", title: item.id, status: item.id === "failed" ? "failed" : "succeeded",
      occurredAt: `2026-08-06T12:0${index}:00.000Z`, events: [],
    }));

    const result = deriveOperatorActivity({ executions: [], tasks: [], deployments: [], activity });
    const byId = new Map(result.recent.map((story) => [story.id, story]));

    expect(byId.get("delivered")).toMatchObject({ summary: "Reply delivered", tone: "success", hasParent: true });
    expect(byId.get("pending")).toMatchObject({ hasParent: false });
    expect(byId.get("pending")).toMatchObject({ summary: "Reply ready · delivery pending", tone: "warning", status: "delivery_pending" });
    expect(byId.get("abandoned")).toMatchObject({ summary: "Reply generated · delivery failed", tone: "danger", status: "delivery_failed" });
    expect(byId.get("unobserved")).toMatchObject({ summary: "Reply generated", tone: "success" });
    expect(byId.get("partial")).toMatchObject({ summary: "Partial reply delivered", tone: "warning", status: "partial" });
    expect(byId.get("failed")).toMatchObject({ summary: "Prompt failed · error delivered", tone: "danger" });
  });

  it("classifies successful background work as system activity and adds releases", () => {
    const result = deriveOperatorActivity({
      executions: [], tasks: [],
      activity: [{
        id: "runtime-background", kind: "runtime", title: "Embedding batch", status: "succeeded",
        occurredAt: "2026-08-06T12:02:00.000Z", events: [
          { id: "1", name: "background.job.started", level: "info", createdAt: "2026-08-06T12:00:00.000Z" },
        ],
      }],
      deployments: [{ deploymentId: "deploy-a", revision: "abcdef123456", verifiedAt: "2026-08-06T12:03:00.000Z" }],
    });

    expect(result.recent[0]).toMatchObject({ kind: "release", title: "Release abcdef1234", tone: "success" });
    expect(result.recent[1]).toMatchObject({ kind: "system", category: "system", summary: "Background work completed" });
  });

  it("keeps automated improvement assessment work out of the product feed", () => {
    const result = deriveOperatorActivity({
      executions: [], deployments: [], activity: [],
      tasks: [{
        taskId: "task-assessment", taskType: "improvement_report", title: "Assess an improvement",
        status: "running", startedAt: "2026-08-06T12:00:00.000Z", updatedAt: "2026-08-06T12:01:00.000Z",
      }],
    });

    expect(result.active[0]).toMatchObject({ kind: "system", category: "system", tone: "active" });
  });

  it("rolls up repeated successful system jobs while preserving failed runs", () => {
    const result = deriveOperatorActivity({
      executions: [], tasks: [], deployments: [],
      activity: [
        { id: "embed-1", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "succeeded", durationMs: 10_000, occurredAt: "2026-08-06T12:03:00.000Z", events: [] },
        { id: "embed-2", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "succeeded", durationMs: 30_000, occurredAt: "2026-08-06T12:02:00.000Z", events: [] },
        { id: "embed-failed", kind: "system", title: "Embedding batch", rollupKey: "embedding", status: "failed", durationMs: 5_000, occurredAt: "2026-08-06T12:01:00.000Z", events: [] },
      ],
    });

    expect(result.recent).toHaveLength(2);
    expect(result.recent.find((story) => story.id === "system-rollup-embedding")).toMatchObject({
      title: "Embedding jobs", runCount: 2, successCount: 2, failureCount: 0, p95DurationMs: 30_000,
    });
    expect(result.recent.find((story) => story.id === "embed-failed")).toMatchObject({ tone: "danger", summary: "Background work failed" });
  });

  it("keeps one improvement story per case and folds linked code work into it", () => {
    const result = deriveOperatorActivity({
      executions: [], tasks: [], deployments: [],
      activity: [{
        id: "improvement-case-a", kind: "improvement", improvementCaseId: "case-a",
        title: "Improve delivery visibility", status: "verifying", detail: "verification.passed",
        occurredAt: "2026-08-06T12:05:00.000Z", events: [
          { id: "verify", name: "verification.passed", level: "info", createdAt: "2026-08-06T12:05:00.000Z" },
          { id: "created", name: "case.created", level: "info", createdAt: "2026-08-06T12:00:00.000Z" },
        ],
      }, {
        id: "task-case-a", kind: "code_change", improvementCaseId: "case-a", title: "Implement fix",
        status: "completed", occurredAt: "2026-08-06T12:04:00.000Z", durationMs: 40_000,
        branchName: "kartik/fix", pullRequestUrl: "https://github.com/owner/repo/pull/2", events: [],
      }],
    });

    expect(result.recent).toHaveLength(1);
    expect(result.recent[0]).toMatchObject({
      kind: "improvement", improvementCaseId: "case-a", summary: "Verification passed",
      branchName: "kartik/fix", pullRequestUrl: "https://github.com/owner/repo/pull/2", durationMs: 40_000,
    });
    expect(result.recent[0]?.lifecycle.map((step) => step.label)).toEqual(["Reported", "Verification passed"]);
  });

  it("retains open improvements outside the recent event window and exposes filterable work state", () => {
    const result = deriveOperatorActivity({
      executions: [], tasks: [], deployments: [], activity: [{
        id: "improvement-case-a", kind: "improvement", improvementCaseId: "case-a",
        title: "Stale event title", status: "actionable", detail: "contract.accepted",
        occurredAt: "2026-07-20T12:00:00.000Z", events: [],
      }],
      improvements: { cases: [{
        caseId: "case-a", title: "Current case title", status: "in_progress", severity: "critical",
        automationState: "progressing", blocker: "deployment verification failed",
        lastProgressAt: "2026-08-06T12:00:00.000Z", firstSeenAt: "2026-07-19T12:00:00.000Z",
      }, {
        caseId: "case-b", title: "Needs reporter context", status: "needs_evidence", severity: "medium",
        automationState: "waiting", nextAction: "wait for reporter",
        lastProgressAt: "2026-07-01T12:00:00.000Z", firstSeenAt: "2026-06-30T12:00:00.000Z",
      }] },
    });

    expect(result.recent).toHaveLength(2);
    expect(result.recent.find((story) => story.improvementCaseId === "case-a")).toMatchObject({
      id: "improvement-case-a", workState: "blocked", category: "failure", tone: "danger",
      status: "in_progress", summary: "Deployment verification failed",
    });
    expect(result.recent.find((story) => story.improvementCaseId === "case-b")).toMatchObject({
      id: "improvement-case-b", workState: "waiting", category: "product", tone: "warning",
      summary: "Wait for reporter",
    });
  });

  it("folds active linked code work into the improvement story", () => {
    const result = deriveOperatorActivity({
      executions: [], deployments: [], activity: [],
      tasks: [{
        taskId: "task-a", taskType: "code_update", improvementCaseId: "case-a", title: "Implement fix",
        status: "running", branchName: "kartik/fix", startedAt: "2026-08-06T12:00:00.000Z",
        updatedAt: "2026-08-06T12:05:00.000Z",
      }],
      improvements: { cases: [{
        caseId: "case-a", title: "Improve delivery", status: "in_progress", severity: "high",
        automationState: "progressing", lastProgressAt: "2026-08-06T12:04:00.000Z",
      }] },
    });

    expect(result.active).toHaveLength(1);
    expect(result.recent).toHaveLength(0);
    expect(result.active[0]).toMatchObject({
      id: "improvement-case-a", kind: "improvement", improvementCaseId: "case-a",
      title: "Improve delivery", workState: "active", branchName: "kartik/fix",
    });
  });

  it("adds work state when the source already supplies projected activity", () => {
    const result = retainOpenImprovementActivity({
      active: [],
      recent: [{
        id: "improvement-case-a", kind: "improvement", improvementCaseId: "case-a", title: "Improve delivery",
        status: "actionable", tone: "neutral", category: "product", workState: null, summary: "Marked actionable",
        occurredAt: "2026-08-06T12:00:00.000Z", startedAt: "2026-08-06T11:00:00.000Z",
        durationMs: null, latencyTone: null, attempts: null, branchName: null, pullRequestUrl: null,
        sourceUrl: null, responseUrl: null, responseKind: null, hasParent: false, rollupKey: null,
        runCount: null, successCount: null, failureCount: null, p95DurationMs: null,
        runs: [], lifecycle: [], technicalEvents: [],
      }],
    }, { cases: [{
      caseId: "case-a", title: "Improve delivery", status: "needs_evidence", severity: "medium",
      automationState: "waiting", lastProgressAt: "2026-08-06T12:01:00.000Z",
    }] });

    expect(result.recent[0]).toMatchObject({ workState: "waiting", tone: "warning", status: "needs_evidence" });
  });

  it("turns implementation event names into operator language", () => {
    expect(eventLabel("discord.delivery.intent_stored")).toBe("Delivery queued");
    expect(improvementMilestone("reconciliation.awaiting_reporter")).toBe("Waiting for reporter context");
    expect(improvementMilestone("verification.passed")).toBe("Verification passed");
  });
});
