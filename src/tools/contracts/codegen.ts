import { sandboxTasksAvailable } from "../../capabilities/codeUpdates.js";
import { defineTool, installToolsWhen, type ToolRegistryEntry } from "../toolDefinition.js";

export const codegenToolContracts = installToolsWhen(sandboxTasksAvailable, [
  defineTool({
    name: "runSandboxAgent",
    category: "coding",
    toolClass: "coding",
    examples: ["@ai debug the failing CI on that PR", "@ai try this game and see how far you get", "@ai run this installer and tell me what it does"],
    description:
      "Start a task in an isolated, disposable sandbox computer; its result is posted back to this Discord message. mode=computer: download, install, run, play, or operate a linked or attached program, game, file, or site (Windows .exe runs via Wine) and report what happened with screenshots. mode=code_change: an explicitly requested change to this bot's repository. mode=diagnosis: explicitly read-only repository/GitHub investigation, including failing CI, checks, or tests. Generic requests about my reports or improvement inbox call listMyImprovementSignals first. Never for public-web research. Requires explicit current-turn intent; any guild member may start a task.",
    mutates: true,
    group: "codegen",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description:
            "The member's full request with every relevant file, share, or attachment URL. Preserve the user's desired outcome; keep combined wording like 'where is X defined, can we change it?' as a change request."
        },
        mode: {
          type: "string",
          enum: ["code_change", "diagnosis", "computer"],
          description: "Task outcome contract; defaults to code_change. See the tool description."
        },
        title: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description:
            "Concise human task title in plain English, 3-8 words, without prefixes like Agent Codegen. Name the intended change or outcome, not just the investigation. Example: Increase model output token limit."
        },
        improvementCaseId: {
          type: "string",
          description: "Optional actionable improvement case ID returned by listMyImprovementSignals. Linking requires the current requester to own a signal in the case and preserves its verification lifecycle."
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
      required: ["request", "title"],
      additionalProperties: false
    }
  }),

  defineTool({
    name: "getAgentTaskStatus",
    toolClass: "coding",
    examples: ["@ai what happened to the last update?"],
    description:
      "Look up quick status for the current or recent sandbox task: progress events, sandbox command output snippets, PR link, and GitHub PR/CI check status when available. Use for read-only status questions like whether an update is done, what PR was opened, or what the latest task ID is. If the user asks to debug, investigate, explain, or fix a GitHub/CI/check/test/repo failure, call runSandboxAgent so the sandbox can use gh CLI, logs, repo files, and tests.",
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
      "List recent visible sandbox tasks with their statuses. Use when a user asks for task history, queued work, previous PR attempts, or what updates are in progress.",
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
      "Retry a failed, no-change, or cancelled sandbox task using the original request and mode. Use when a user asks to retry, rerun, or try again after a code-update task did not complete.",
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
      "Cancel an active queued or running sandbox task. Use when a user asks to stop, cancel, abort, or kill an in-progress sandbox task.",
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
] satisfies ToolRegistryEntry[]);
