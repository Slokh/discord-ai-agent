import http from "node:http";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { DiscordAiAgentRepository } from "../db/repositories.js";
import { getRunSnapshot } from "../observability/runs.js";
import { logger } from "../util/logger.js";

export async function streamRunSnapshots(input: {
  repo: DiscordAiAgentRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  runId: string;
}) {
  input.response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  let closed = false;
  let lastSignature = "";
  let previousSnapshot: Awaited<ReturnType<typeof getRunSnapshot>> | null =
    null;
  input.request.on("close", () => {
    closed = true;
  });

  const sendSnapshot = async () => {
    if (closed || input.response.destroyed) return;
    const snapshot = await getRunSnapshot(input.repo, input.runId);
    if (!snapshot) {
      input.response.write(
        `event: error\ndata: ${JSON.stringify({ error: "run_not_found" })}\n\n`,
      );
      input.response.end();
      closed = true;
      return;
    }
    const signature = runSnapshotSignature(snapshot);
    if (signature === lastSignature) {
      input.response.write(
        `event: heartbeat\ndata: ${JSON.stringify({ generatedAt: snapshot.generatedAt })}\n\n`,
      );
      return;
    }
    lastSignature = signature;
    if (!previousSnapshot) {
      previousSnapshot = snapshot;
      input.response.write(
        `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
      );
      return;
    }
    const delta = runSnapshotDelta(previousSnapshot, snapshot);
    previousSnapshot = snapshot;
    input.response.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`);
  };

  await sendSnapshot();
  const interval = setInterval(() => {
    void sendSnapshot().catch((error) => {
      logger.warn(
        { err: error, runId: input.runId },
        "Failed to stream run snapshot",
      );
    });
  }, 2000);
  interval.unref?.();

  await new Promise<void>((resolve) => {
    input.request.on("close", resolve);
    input.response.on("close", resolve);
  });
  clearInterval(interval);
}

function runSnapshotDelta(
  previous: NonNullable<Awaited<ReturnType<typeof getRunSnapshot>>>,
  next: NonNullable<Awaited<ReturnType<typeof getRunSnapshot>>>,
) {
  const previousSpanIds = new Set(previous.spans.map((item) => item.id));
  const previousEventIds = new Set(previous.events.map((item) => item.id));
  const previousArtifactIds = new Set(
    previous.artifacts.map((item) => item.artifactId),
  );
  const previousTranscriptIds = new Set(
    (previous.agentTranscript ?? []).map((item) => item.id),
  );
  return {
    version: next.run.updatedAt,
    run: next.run,
    spans: next.spans.filter((item) => !previousSpanIds.has(item.id)),
    events: next.events.filter((item) => !previousEventIds.has(item.id)),
    artifacts: next.artifacts.filter(
      (item) => !previousArtifactIds.has(item.artifactId),
    ),
    agentTranscript: (next.agentTranscript ?? []).filter(
      (item) => !previousTranscriptIds.has(item.id),
    ),
    terminal:
      next.terminal.lineCount === previous.terminal.lineCount
        ? null
        : next.terminal,
    diagnostics: next.diagnostics,
    raw: next.raw,
    relatedRuns: next.relatedRuns,
    generatedAt: next.generatedAt,
  };
}

function runSnapshotSignature(
  snapshot: Awaited<ReturnType<typeof getRunSnapshot>>,
) {
  if (!snapshot) return "missing";
  return JSON.stringify({
    updatedAt: snapshot.run.updatedAt,
    status: snapshot.run.status,
    spans: [
      snapshot.spans.length,
      snapshot.spans.at(-1)?.id,
      snapshot.spans.at(-1)?.status,
    ],
    events: [snapshot.events.length, snapshot.events.at(-1)?.id],
    artifacts: [
      snapshot.artifacts.length,
      snapshot.artifacts.at(-1)?.artifactId,
    ],
    transcript: [
      snapshot.agentTranscript?.length ?? 0,
      snapshot.agentTranscript?.at(-1)?.id,
    ],
    terminalLines: snapshot.terminal.lineCount,
    relatedRuns: snapshot.relatedRuns.map((run) => [
      run.runId,
      run.status,
      run.updatedAt,
    ]),
  });
}

export async function streamAgentEvents(input: {
  agentRepo: AgentRuntimeRepository;
  request: http.IncomingMessage;
  response: http.ServerResponse;
  threadKey: string;
  executionId: string | null;
  afterEventId: number | null;
}) {
  input.response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  const session = await input.agentRepo.getSession({
    threadKey: input.threadKey,
  });
  if (!session) {
    input.response.write(
      `event: error\ndata: ${JSON.stringify({ error: "agent_session_not_found" })}\n\n`,
    );
    input.response.end();
    return;
  }

  let closed = false;
  let afterEventId = input.afterEventId ?? 0;
  input.request.on("close", () => {
    closed = true;
  });

  const sendEvents = async () => {
    if (closed || input.response.destroyed) return;
    const events = await input.agentRepo.listEvents({
      sessionId: session.sessionId,
      executionId: input.executionId,
      afterEventId,
      limit: 200,
    });
    for (const event of events) {
      afterEventId = Math.max(afterEventId, event.id);
      input.response.write(
        `event: agent.event\ndata: ${JSON.stringify(event)}\n\n`,
      );
    }
    input.response.write(
      `event: heartbeat\ndata: ${JSON.stringify({ afterEventId, generatedAt: new Date().toISOString() })}\n\n`,
    );
  };

  await sendEvents();
  const interval = setInterval(() => {
    void sendEvents().catch((error) => {
      logger.warn(
        {
          err: error,
          threadKey: input.threadKey,
          executionId: input.executionId,
        },
        "Failed to stream agent runtime events",
      );
    });
  }, 2000);
  interval.unref?.();

  await new Promise<void>((resolve) => {
    input.request.on("close", resolve);
    input.response.on("close", resolve);
  });
  clearInterval(interval);
}
