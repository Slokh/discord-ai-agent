/**
 * One sandbox, several workload profiles.
 *
 * Every agent task runs through the same queue, Kubernetes Job, runner,
 * NanoCodex harness, signed callbacks, and delivery. A task type selects only
 * its profile: which workspace the runner prepares, which capabilities the
 * sandbox exposes, which upstream credentials it may use, and whether a clean
 * text result is a complete outcome or a repository diff is required.
 */

export const AGENT_TASK_TYPES = [
  "code_update",
  "improvement_report",
  "improvement_repair",
  "diagnosis",
  "computer_task",
] as const;

export type AgentTaskType = (typeof AGENT_TASK_TYPES)[number];

export type SandboxCredential = "github" | "openrouter";

export type SandboxProfile = {
  name: "repository" | "computer";
  /** `repository` prepares a cached checkout; `scratch` starts in an empty workspace. */
  workspace: "repository" | "scratch";
  /** A clean, non-empty final answer completes the task without a diff. */
  acceptsResultWithoutDiff: boolean;
  /** The task may open or update a pull request. */
  publishesPullRequest: boolean;
  /** The terminal result is posted back to the requester's Discord message. */
  deliversResultToRequester: boolean;
  capabilities: {
    dependencyCache: boolean;
    desktop: boolean;
    fileDownload: boolean;
  };
  credentials: readonly SandboxCredential[];
};

const REPOSITORY_CAPABILITIES = { dependencyCache: true, desktop: false, fileDownload: false } as const;

const PROFILES: Record<AgentTaskType, SandboxProfile> = {
  code_update: {
    name: "repository",
    workspace: "repository",
    acceptsResultWithoutDiff: false,
    publishesPullRequest: true,
    deliversResultToRequester: true,
    capabilities: REPOSITORY_CAPABILITIES,
    credentials: ["github", "openrouter"],
  },
  improvement_repair: {
    name: "repository",
    workspace: "repository",
    acceptsResultWithoutDiff: false,
    publishesPullRequest: true,
    // Improvement work reports through the reporter-conversation lifecycle instead.
    deliversResultToRequester: false,
    capabilities: REPOSITORY_CAPABILITIES,
    credentials: ["github", "openrouter"],
  },
  improvement_report: {
    name: "repository",
    workspace: "repository",
    acceptsResultWithoutDiff: true,
    publishesPullRequest: true,
    deliversResultToRequester: false,
    capabilities: REPOSITORY_CAPABILITIES,
    credentials: ["github", "openrouter"],
  },
  diagnosis: {
    name: "repository",
    workspace: "repository",
    acceptsResultWithoutDiff: true,
    publishesPullRequest: false,
    deliversResultToRequester: true,
    capabilities: { ...REPOSITORY_CAPABILITIES, dependencyCache: false },
    credentials: ["github", "openrouter"],
  },
  computer_task: {
    name: "computer",
    workspace: "scratch",
    acceptsResultWithoutDiff: true,
    publishesPullRequest: false,
    deliversResultToRequester: true,
    capabilities: { dependencyCache: false, desktop: true, fileDownload: true },
    credentials: ["openrouter"],
  },
};

export function sandboxProfileForTaskType(taskType: AgentTaskType): SandboxProfile {
  return PROFILES[taskType];
}

export function parseAgentTaskType(value: unknown): AgentTaskType | null {
  return typeof value === "string" && (AGENT_TASK_TYPES as readonly string[]).includes(value)
    ? (value as AgentTaskType)
    : null;
}

export function taskTypesDeliveringResults(): AgentTaskType[] {
  return AGENT_TASK_TYPES.filter((taskType) => PROFILES[taskType].deliversResultToRequester);
}

export function sandboxProfileRequires(taskType: AgentTaskType, credential: SandboxCredential) {
  return sandboxProfileForTaskType(taskType).credentials.includes(credential);
}

/**
 * Model-facing task modes. Retrying a task re-enters through the same mode so
 * a retry never silently changes what the original request asked for.
 */
export const SANDBOX_TASK_MODES = ["code_change", "diagnosis", "computer"] as const;

export type SandboxTaskMode = (typeof SANDBOX_TASK_MODES)[number];

/**
 * Staged rollout for each mode: dormant, open only to the configured bot
 * owner and ops allowlist while it is proven in production, then open to
 * every guild member.
 */
export const SANDBOX_MODE_ROLLOUTS = ["off", "operators", "everyone"] as const;

export type SandboxModeRollout = (typeof SANDBOX_MODE_ROLLOUTS)[number];

export function taskTypeForSandboxMode(mode: SandboxTaskMode): Extract<AgentTaskType, "code_update" | "diagnosis" | "computer_task"> {
  if (mode === "diagnosis") return "diagnosis";
  if (mode === "computer") return "computer_task";
  return "code_update";
}

export function sandboxModeForTaskType(taskType: string): SandboxTaskMode {
  if (taskType === "diagnosis") return "diagnosis";
  if (taskType === "computer_task") return "computer";
  return "code_change";
}
