export type AgentTaskStatus = "queued" | "running" | "succeeded" | "failed" | "no_changes" | "cancelled";

export type AgentTaskJob = {
  taskId: string;
  traceId?: string;
  taskType: "code_update" | "improvement_report" | "diagnosis";
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
  improvementCaseId?: string;
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

export type SandboxEnv = {
  taskType: AgentTaskJob["taskType"];
  taskId: string;
  traceId: string;
  sandboxRunId: string;
  taskTitle: string;
  taskRequest: string;
  improvementAssessmentResultPath: string;
  requestedBy: string;
  targetBranch: string | null;
  targetPullRequestNumber: number | null;
  targetPullRequestUrl: string | null;
  callbackServerUrl: string;
  taskToken: string;
  taskCallbackSecret: string;
  githubToken: string;
  githubRepository: string;
  githubBaseBranch: string;
  openRouterApiKey: string;
  openRouterBaseUrl?: string;
  openRouterCodegenModel: string;
  sandboxCacheDir: string;
  sandboxStartedAtMs: number | null;
};

export type TaskTimings = Record<string, number>;
