export type RunKind = "codegen" | "discord" | "crawl" | "embedding" | "prompt" | "workflow" | "ops";
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";
export type EventLevel = "debug" | "info" | "warn" | "error";

export type RunCount = {
  name: string;
  count: number;
};

export type RunListAggregate = {
  total: number;
  active: number;
  attention: number;
  terminal: number;
  byStatus: RunCount[];
  byKind: RunCount[];
  codegenDiagnoses: RunCount[];
};

export type RunSummary = {
  runId: string;
  traceId: string | null;
  kind: RunKind;
  status: RunStatus;
  title: string;
  summary: string | null;
  requester: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  messageId: string | null;
  source: string;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  currentStep: string | null;
  bottleneck: { name: string; durationMs: number } | null;
  links: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type RunSpan = {
  id: string;
  source: "process" | "task" | "sandbox" | "command";
  name: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunEvent = {
  id: string;
  source: "process" | "trace" | "task" | "tool" | "command";
  level: EventLevel;
  name: string;
  summary: string | null;
  createdAt: string;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunArtifact = {
  artifactId: string;
  runId: string;
  kind: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  preview: string;
  redacted: boolean;
  expiresAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type TerminalEntry = {
  id: string;
  source: "command";
  stream: "command" | "stdout" | "stderr" | "exit";
  step: string;
  command: string | null;
  createdAt: string;
  content: string;
};

export type RunSnapshot = {
  run: RunSummary;
  spans: RunSpan[];
  events: RunEvent[];
  artifacts: RunArtifact[];
  terminal: { lineCount: number; content: string; entries: TerminalEntry[] };
  diagnostics: string[];
  raw: Record<string, unknown>;
  relatedRuns: RunSummary[];
  generatedAt: string;
};

export type RunListResponse = {
  runs: RunSummary[];
  aggregate: RunListAggregate;
  generatedAt: string;
};
