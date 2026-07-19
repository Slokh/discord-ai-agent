export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentTaskJob = {
  taskId: string;
  traceId?: string;
  taskType: "code_update";
  request: string;
  title: string;
  requestedBy: string;
  targetBranch?: string;
  targetPullRequestNumber?: number;
  targetPullRequestUrl?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  threadKey?: string;
  discordResponseChannelId?: string;
  discordResponseMessageId?: string;
  retriedFromTaskId?: string;
  parentAgentSessionId?: string;
  parentAgentExecutionId?: string;
  parentAgentThreadKey?: string;
};

export type AgentTaskStartResult = {
  sandboxRunId: string;
  backendJobName: string;
  namespace?: string | null;
  image?: string | null;
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

export type CodegenHarness = "codex" | "opencode";

export type SandboxEnv = {
  taskId: string;
  traceId: string;
  sandboxRunId: string;
  taskTitle: string;
  taskRequest: string;
  requestedBy: string;
  targetBranch: string | null;
  targetPullRequestNumber: number | null;
  targetPullRequestUrl: string | null;
  controlPlaneInternalUrl: string;
  taskToken: string;
  taskSigningSecret: string;
  githubToken: string;
  githubRepository: string;
  githubBaseBranch: string;
  openRouterApiKey: string;
  openRouterChatModel: string;
  openRouterCodegenModel: string;
  codegenHarness: CodegenHarness;
  sandboxCacheDir: string;
  sandboxStartedAtMs: number | null;
};

export type TaskTimings = Record<string, number>;
