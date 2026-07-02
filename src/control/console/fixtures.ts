import type { RunSnapshot, RunSummary } from "./types.js";

const now = new Date("2026-06-30T16:10:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

export const fixtureSnapshots: RunSnapshot[] = [
  {
    run: {
      runId: "task-fixture-success",
      traceId: "task-fixture-success",
      kind: "codegen",
      status: "succeeded",
      title: "Add reply parent context",
      summary: "Opened pull request.",
      requester: "kartik",
      guildId: "guild",
      channelId: "general",
      userId: "user",
      messageId: null,
      source: "agent_task",
      startedAt: minutesAgo(42),
      completedAt: minutesAgo(24),
      updatedAt: minutesAgo(24),
      durationMs: 18 * 60_000,
      currentStep: "done",
      bottleneck: { name: "codex", durationMs: 14 * 60_000 },
      links: { pullRequest: "https://github.com/Slokh/discord-ai-agent/pull/42" },
      metadata: { backend: "kubernetes-sandbox", verifyPassed: true }
    },
    spans: [
      span("sandbox", "succeeded", 42, 41.8, 12_000, "sandbox"),
      span("dependencies", "succeeded", 41.8, 41.2, 36_000, "task"),
      span("codex", "succeeded", 41.2, 27.2, 14 * 60_000, "command"),
      span("verify", "succeeded", 27.2, 25.4, 108_000, "command"),
      span("pr", "succeeded", 25.4, 24, 84_000, "process")
    ],
    events: [
      event("task.progress", "info", "Sandbox process started.", 42, "task"),
      event("sandbox.command", "info", "codex exited 0", 27.2, "command"),
      event("task.completed", "info", "Opened pull request.", 24, "task")
    ],
    artifacts: [
      artifact("artifact-prompt", "prompt", "Codex prompt", 1880),
      artifact("artifact-diff", "diff", "Git patch", 9234),
      artifact("artifact-pr", "pr_body", "Pull request body", 1315)
    ],
    terminal: terminal([
      terminalEntry("terminal-1-command", "command", "codex", "$ codex exec ..."),
      terminalEntry("terminal-1-stdout", "stdout", "codex", "Reading files...\nEditing src/discord/client.ts\nRunning tests..."),
      terminalEntry("terminal-1-exit", "exit", "codex", "[exit 0 in 14m]"),
      terminalEntry("terminal-2-command", "command", "verify", "$ npm run verify"),
      terminalEntry("terminal-2-stdout", "stdout", "verify", "passed"),
      terminalEntry("terminal-2-exit", "exit", "verify", "[exit 0 in 1m 48s]")
    ]),
    diagnostics: ["Most time was spent in codex: 14m 0s.", "All checks passed before the PR opened."],
    raw: {},
    relatedRuns: [],
    generatedAt: now.toISOString()
  },
  {
    run: {
      runId: "discord-fixture-timeout",
      traceId: "1521541635580756031",
      kind: "discord",
      status: "failed",
      title: "Discord mention from Luke",
      summary: "Discord AI Agent agent request timed out.",
      requester: "Luke",
      guildId: "guild",
      channelId: "general",
      userId: "luke",
      messageId: "1521541635580756031",
      source: "discord",
      startedAt: minutesAgo(17),
      completedAt: minutesAgo(2),
      updatedAt: minutesAgo(2),
      durationMs: 15 * 60_000,
      currentStep: "agent.request",
      bottleneck: { name: "Run model-led agent", durationMs: 15 * 60_000 },
      links: { discordMessage: "https://discord.com/channels/guild/general/1521541635580756031" },
      metadata: { visibleChannelCount: 151 }
    },
    spans: [
      span("Load channel memory", "succeeded", 17, 16.98, 1200, "process"),
      span("Resolve Discord permissions", "succeeded", 16.98, 16.9, 4200, "process"),
      span("Run model-led agent", "failed", 16.9, 2, 15 * 60_000, "process")
    ],
    events: [
      event("discord.mention.received", "info", "over the past 3 months who is the best at little phone games", 17, "trace"),
      event("searchDiscordHistory", "info", "searched indexed messages", 16, "tool"),
      event("discord.mention.failed", "error", "Discord AI Agent agent request timed out.", 2, "trace")
    ],
    artifacts: [artifact("artifact-discord-prompt", "prompt", "Discord user prompt", 82), artifact("artifact-error", "response", "Discord error response", 97)],
    terminal: terminal([]),
    diagnostics: ["Most time was spent in Run model-led agent: 15m 0s.", "Latest failure signal: Discord AI Agent agent request timed out."],
    raw: {},
    relatedRuns: [
      {
        runId: "task-fixture-child-running",
        traceId: "1521541635580756031",
        kind: "codegen",
        status: "running",
        title: "Investigate Discord timeout",
        summary: "Waiting for the first code diff.",
        requester: "Luke",
        guildId: "guild",
        channelId: "general",
        userId: "luke",
        messageId: null,
        source: "agent_task",
        startedAt: minutesAgo(15),
        completedAt: null,
        updatedAt: minutesAgo(1),
        durationMs: null,
        currentStep: "codex_app_server_attempt_1",
        bottleneck: null,
        links: {},
        metadata: {}
      }
    ],
    generatedAt: now.toISOString()
  },
  {
    run: {
      runId: "embedding-fixture-running",
      traceId: "embedding-fixture-running",
      kind: "embedding",
      status: "running",
      title: "Embedding batch (400 messages)",
      summary: "Processing 400 message embedding jobs.",
      requester: "system",
      guildId: null,
      channelId: null,
      userId: null,
      messageId: null,
      source: "pgboss.embedding",
      startedAt: minutesAgo(1),
      completedAt: null,
      updatedAt: minutesAgo(0),
      durationMs: null,
      currentStep: "openrouter.embed",
      bottleneck: { name: "OpenRouter embed batch 2", durationMs: 8900 },
      links: {},
      metadata: { jobCount: 400, messageCount: 400, backlog: 18200 }
    },
    spans: [
      span("Load messages for embedding", "succeeded", 1, 0.95, 280, "process"),
      span("OpenRouter embed batch 1", "succeeded", 0.95, 0.8, 8500, "process"),
      span("OpenRouter embed batch 2", "running", 0.8, 0.65, 8900, "process")
    ],
    events: [event("embedding.message batch", "info", "Running embedding.message batch", 1, "process")],
    artifacts: [artifact("artifact-embedding", "embedding_summary", "Embedding internals", 741)],
    terminal: terminal([]),
    diagnostics: ["Most time was spent in OpenRouter embed batch 2: 8.900s.", "Currently active at openrouter.embed.", "Embedding backlog at run time: 18200."],
    raw: {},
    relatedRuns: [],
    generatedAt: now.toISOString()
  }
];

export const fixtureRuns: RunSummary[] = fixtureSnapshots.map((snapshot) => snapshot.run);

export function fixtureArtifact(runId: string, artifactId: string) {
  return `Fixture artifact ${artifactId} for ${runId}\n\nThis is the full artifact body that would come from Postgres in live mode.`;
}

function span(name: string, status: RunSnapshot["spans"][number]["status"], startMinutesAgo: number, endMinutesAgo: number, durationMs: number, source: RunSnapshot["spans"][number]["source"]) {
  return {
    id: `${source}-${name}`,
    source,
    name,
    status,
    startedAt: minutesAgo(startMinutesAgo),
    completedAt: status === "running" ? null : minutesAgo(endMinutesAgo),
    durationMs,
    metadata: {}
  };
}

function event(name: string, level: RunSnapshot["events"][number]["level"], summary: string, minutes: number, source: RunSnapshot["events"][number]["source"]) {
  return {
    id: `${source}-${name}-${minutes}`,
    source,
    level,
    name,
    summary,
    createdAt: minutesAgo(minutes),
    durationMs: null,
    metadata: {}
  };
}

function artifact(artifactId: string, kind: string, name: string, sizeBytes: number) {
  return {
    artifactId,
    runId: "",
    kind,
    name,
    contentType: "text/plain",
    sizeBytes,
    preview: `${name} preview...`,
    redacted: true,
    expiresAt: null,
    metadata: {},
    createdAt: minutesAgo(1)
  };
}

function terminal(entries: RunSnapshot["terminal"]["entries"]) {
  const content = entries.map((entry) => entry.content).join("\n\n");
  return {
    lineCount: content ? content.split("\n").length : 0,
    content,
    entries
  };
}

function terminalEntry(id: string, stream: RunSnapshot["terminal"]["entries"][number]["stream"], step: string, content: string) {
  return {
    id,
    source: "command" as const,
    stream,
    step,
    command: stream === "command" ? content.replace(/^\$ /, "") : null,
    createdAt: minutesAgo(1),
    content
  };
}
