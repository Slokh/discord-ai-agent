import type { DiscordAiAgentRepository, DurableWorkflow, DurableWorkflowStatus } from "../db/repositories.js";
import { durationMs, logger } from "../util/logger.js";

export type DurableWorkflowRunResult = {
  status?: DurableWorkflowStatus;
  state?: Record<string, unknown>;
  nextRunAt?: Date | null;
};

export type DurableWorkflowRunner = {
  kind: string;
  run: (workflow: DurableWorkflow) => Promise<DurableWorkflowRunResult>;
};

export async function runDueDurableWorkflows(input: {
  repo: Pick<
    DiscordAiAgentRepository,
    "listDueDurableWorkflows" | "markDurableWorkflowRunStarted" | "markDurableWorkflowRunFinished" | "recordTraceEvent"
  >;
  runners: DurableWorkflowRunner[];
  limit?: number;
  now?: Date;
}) {
  const runnersByKind = new Map(input.runners.map((runner) => [runner.kind, runner]));
  const workflows = await input.repo.listDueDurableWorkflows({ limit: input.limit ?? 25, now: input.now ?? new Date() });
  const results: Array<{ id: string; kind: string; status: "skipped" | "completed" | "failed" }> = [];

  for (const workflow of workflows) {
    const runner = runnersByKind.get(workflow.kind);
    if (!runner) {
      results.push({ id: workflow.id, kind: workflow.kind, status: "skipped" });
      continue;
    }

    const locked = await input.repo.markDurableWorkflowRunStarted({ id: workflow.id, lockedAt: input.now ?? new Date() });
    if (!locked) {
      results.push({ id: workflow.id, kind: workflow.kind, status: "skipped" });
      continue;
    }

    const startedAt = Date.now();
    await input.repo.recordTraceEvent({
      traceId: workflow.id,
      requestId: workflow.id,
      guildId: workflow.guildId,
      eventName: "workflow.started",
      summary: workflow.name,
      metadata: { workflowId: workflow.id, kind: workflow.kind }
    });

    try {
      const result = await runner.run(workflow);
      await input.repo.markDurableWorkflowRunFinished({
        id: workflow.id,
        status: result.status ?? "active",
        state: result.state,
        nextRunAt: result.nextRunAt ?? null
      });
      await input.repo.recordTraceEvent({
        traceId: workflow.id,
        requestId: workflow.id,
        guildId: workflow.guildId,
        eventName: "workflow.completed",
        summary: workflow.name,
        metadata: { workflowId: workflow.id, kind: workflow.kind, status: result.status ?? "active" },
        durationMs: durationMs(startedAt)
      });
      results.push({ id: workflow.id, kind: workflow.kind, status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, workflowId: workflow.id, kind: workflow.kind }, "Durable workflow failed");
      await input.repo.markDurableWorkflowRunFinished({
        id: workflow.id,
        status: "failed",
        state: { lastError: message },
        nextRunAt: null
      });
      await input.repo.recordTraceEvent({
        traceId: workflow.id,
        requestId: workflow.id,
        guildId: workflow.guildId,
        eventName: "workflow.failed",
        level: "error",
        summary: message,
        metadata: { workflowId: workflow.id, kind: workflow.kind },
        durationMs: durationMs(startedAt)
      });
      results.push({ id: workflow.id, kind: workflow.kind, status: "failed" });
    }
  }

  return results;
}
