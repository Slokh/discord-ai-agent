export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentTaskJob = {
  taskId: string;
  traceId?: string;
  taskType: "code_update";
  request: string;
  title: string;
  requestedBy: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  threadKey?: string;
  discordResponseChannelId?: string;
  discordResponseMessageId?: string;
  retriedFromTaskId?: string;
};

export type AgentTaskStartResult = {
  sandboxRunId: string;
  backendJobName: string;
  metadata?: Record<string, unknown>;
};

export type AgentTaskProgressEvent = {
  step: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type AgentTaskCompletionEvent = {
  status: Extract<AgentTaskStatus, "succeeded" | "failed" | "no_changes" | "cancelled">;
  branchName?: string | null;
  prUrl?: string | null;
  draft?: boolean | null;
  verifyPassed?: boolean | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
};
