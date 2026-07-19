import type {
  AgentTaskRecord,
  ProcessRunArtifactRecord,
  ProcessRunKind,
  ProcessRunRecord,
  ProcessRunStatus,
  SandboxRunRecord,
} from "../db/repositories.js";
import type {
  RuntimeEventCategory,
  RuntimeEventPhase,
} from "./runtimeEventSchema.js";

export type RunSummary = {
  runId: string;
  traceId: string | null;
  kind: ProcessRunKind;
  status: ProcessRunStatus;
  title: string;
  summary: string | null;
  requester: string | null;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  messageId: string | null;
  source: string;
  startedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
  durationMs: number | null;
  currentStep: string | null;
  bottleneck: { name: string; durationMs: number } | null;
  links: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type RunSpan = {
  id: string;
  source: "process" | "task" | "sandbox" | "command" | "runtime";
  name: string;
  status: ProcessRunStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
};

export type RunEvent = {
  id: string;
  source: "process" | "trace" | "runtime" | "task" | "tool" | "command";
  level: "debug" | "info" | "warn" | "error";
  name: string;
  summary: string | null;
  createdAt: Date;
  durationMs: number | null;
  category?: RuntimeEventCategory;
  phase?: RuntimeEventPhase;
  spanId?: string | null;
  parentSpanId?: string | null;
  metadata: Record<string, unknown>;
};

export type RunArtifactSummary = ProcessRunArtifactRecord;

export type RunAgentTranscriptMessage = {
  id: string;
  sessionId: string;
  clientMessageId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  parts: unknown[];
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type RunTerminalEntry = {
  id: string;
  source: "command";
  stream: "command" | "stdout" | "stderr" | "exit";
  step: string;
  command: string | null;
  createdAt: Date;
  content: string;
};

export type RunSnapshot = {
  run: RunSummary;
  spans: RunSpan[];
  events: RunEvent[];
  artifacts: RunArtifactSummary[];
  terminal: {
    lineCount: number;
    content: string;
    entries: RunTerminalEntry[];
  };
  diagnostics: string[];
  raw: {
    processRun?: ProcessRunRecord;
    task?: AgentTaskRecord;
    sandboxRuns: SandboxRunRecord[];
  };
  agentTranscript: RunAgentTranscriptMessage[];
  relatedRuns: RunSummary[];
  generatedAt: Date;
};

export type RunResolution = {
  run: RunSummary;
  messageId: string;
};
