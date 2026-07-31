import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const codegenToolContracts = [
  defineTool({
    name: "runCodingAgent",
    category: "coding",
    toolClass: "coding",
    examples: ["@ai debug the failing CI on that PR"],
    description:
      "Start an isolated sandbox task for Discord AI Agent code, repository, GitHub PR, CI, deployment, or self-update work. Any guild member may start a task, subject to the configured per-user daily codegen limit. The bot will update the same Discord reply with progress and the PR link when the task finishes. Use when the user asks the agent to update itself, add, build, implement, change behavior, debug or fix failing CI/checks/tests, inspect a PR/repo failure, or continue work from a previous code-update task. Prefer this over hosted web tools for GitHub, CI, PR, or repository debugging because the sandbox has repo checkout, shell, tests, and gh CLI access.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "The full requested agent update, integration, or repository change to implement. Preserve the user's desired outcome, especially when the wording combines investigation with an action like 'where is X defined, can we change/increase/fix it?'. Do not reduce that to a read-only find/debug request."
        },
        title: {
          type: "string",
          description:
            "Optional concise human PR title in plain English, 3-8 words, without prefixes like Agent Codegen. Name the intended change, not just the investigation. Example: Increase model output token limit."
        },
        targetBranch: {
          type: "string",
          description:
            "Optional existing Git branch to update instead of creating a new branch. Set this when the user asks to fix, continue, or update an existing PR and the branch is known from context."
        },
        targetPullRequestNumber: {
          type: "number",
          description:
            "Optional existing GitHub pull request number to update. Set this when the user references an existing PR, such as PR #120 or a GitHub pull request URL."
        },
        targetPullRequestUrl: {
          type: "string",
          description:
            "Optional existing GitHub pull request URL to update. Set this when the user provides or replies to a PR link."
        }
      },
      required: ["request"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getAgentTaskStatus",
    toolClass: "coding",
    examples: ["@ai what happened to the last update?"],
    description:
      "Look up quick status for the current or recent code-update task: progress events, sandbox command output snippets, PR link, and GitHub PR/CI check status when available. Use for read-only status questions like whether an update is done, what PR was opened, or what the latest task ID is. If the user asks to debug, investigate, explain, or fix a GitHub/CI/check/test/repo failure, call runCodingAgent so the sandbox can use gh CLI, logs, repo files, and tests.",
    userVisible: true,
    mutates: false,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, returns the latest visible task in this Discord channel."
        },
        limit: {
          type: "number",
          description: "Maximum progress and command events to include. Defaults to 8."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "listAgentTasks",
    toolClass: "coding",
    examples: ["@ai show recent update tasks"],
    description:
      "List recent visible code-update tasks with their statuses. Use when a user asks for task history, queued work, previous PR attempts, or what updates are in progress.",
    userVisible: true,
    mutates: false,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        statuses: {
          type: "array",
          items: {
            type: "string",
            enum: ["queued", "running", "succeeded", "failed", "no_changes", "cancelled"]
          },
          description: "Optional statuses to filter by."
        },
        limit: {
          type: "number",
          description: "Maximum tasks to return. Defaults to 10."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "retryAgentTask",
    toolClass: "coding",
    examples: ["@ai retry that update"],
    description:
      "Retry a failed, no-change, or cancelled code-update task using the original request. Use when a user asks to retry, rerun, or try again after a code-update task did not complete.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, retries the latest retryable visible task in this Discord channel."
        }
      },
      additionalProperties: false
    }
  }),

  defineTool({
    name: "cancelAgentTask",
    toolClass: "coding",
    examples: ["@ai cancel the current update"],
    description:
      "Cancel an active queued or running code-update task. Use when a user asks to stop, cancel, abort, or kill an in-progress self-update.",
    userVisible: true,
    mutates: true,
    group: "codegen",
    category: "coding",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Optional task ID. If omitted, cancels the latest active visible task in this Discord channel."
        },
        reason: {
          type: "string",
          description: "Optional user-facing reason for cancellation."
        }
      },
      additionalProperties: false
    }
  }),
] satisfies ToolRegistryEntry[];
