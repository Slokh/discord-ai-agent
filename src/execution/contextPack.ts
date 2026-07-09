import fs from "node:fs/promises";
import path from "node:path";
import {
  anchorTargetFilesFromMatches,
  extractCodegenRequestAnchors,
  findCodegenAnchorMatches,
  type CodegenAnchorMatch
} from "./codegenAnchors.js";
import { pathExists, tail, uniqueStrings } from "./sandboxUtils.js";

const MAX_REPO_GUIDE_EXCERPT = 3_000;

export type CodegenContextPack = {
  repoGuidePath?: string;
  repoGuideExcerpt?: string;
  requestAnchors?: string[];
  anchorMatches?: CodegenAnchorMatch[];
  anchorTargetFiles?: Array<{ path: string; reason: string }>;
  suggestedFiles?: Array<{ path: string; reason: string }>;
  suggestedCheckCommands?: Array<{ command: string; reason: string }>;
  sandboxContract: string[];
  firstMoveRules: string[];
  projectMap: Array<{
    area: string;
    purpose: string;
    files: string[];
    checks: string[];
  }>;
};

export async function buildCodegenContextPack(checkoutDir: string, taskRequest = ""): Promise<CodegenContextPack> {
  const repoGuidePath = (await pathExists(path.join(checkoutDir, "AGENTS.md"))) ? "AGENTS.md" : undefined;
  const repoGuideExcerpt = repoGuidePath ? await readRepoGuideExcerpt(path.join(checkoutDir, repoGuidePath)) : undefined;
  const requestAnchors = extractCodegenRequestAnchors(taskRequest);
  const anchorMatches = await findCodegenAnchorMatches(checkoutDir, requestAnchors);
  const anchorTargetFiles = anchorTargetFilesFromMatches(anchorMatches);
  const projectMap = await existingProjectMap(checkoutDir, [
    {
      area: "Code-update task lifecycle",
      purpose: "Requests to update the bot become durable agent tasks, Kubernetes sandbox runs, Discord progress edits, and PRs.",
      files: [
        "src/tools/agentTaskTools.ts",
        "src/tools/coreTools.ts",
        "src/jobs/queue.ts",
        "src/execution/backend.ts",
        "src/execution/sandboxRunner.ts",
        "src/discord/taskNotifications.ts",
        "src/db/repositories.ts"
      ],
      checks: ["tests/unit/sandbox-runner.test.ts", "tests/unit/task-notifications.test.ts", "tests/integration/repository-db.test.ts"]
    },
    {
      area: "Discord mention and reply lifecycle",
      purpose: "Incoming Discord messages are persisted, routed through the model/tool loop, and answered or updated in Discord.",
      files: ["src/discord/client.ts", "src/discord/responseSink.ts", "src/agent/router.ts", "src/discord/messagePersistence.ts", "src/db/repositories.ts"],
      checks: ["tests/unit/discord-response-sink.test.ts", "tests/unit/discord-client.test.ts", "tests/integration/agent.test.ts", "tests/unit/message-persistence.test.ts"]
    },
    {
      area: "Discord knowledge, indexing, and retrieval",
      purpose:
        "Discord history is stored, indexed, embedded, searched, summarized, and filtered through durable data owners before tools expose it to the model.",
      files: [
        "src/db/repositories.ts",
        "src/discord/crawler.ts",
        "src/discord/messagePersistence.ts",
        "src/memory/search.ts",
        "src/memory/embedding.ts",
        "src/tools/discordHistoryFormatting.ts",
        "src/tools/discordStatsFormatting.ts",
        "src/tools/discordChannelTopics.ts",
        "src/tools/discordAttachments.ts"
      ],
      checks: [
        "tests/integration/repository-db.test.ts",
        "tests/unit/crawler.test.ts",
        "tests/unit/message-persistence.test.ts",
        "tests/unit/search.test.ts",
        "tests/unit/core-tools.test.ts"
      ]
    },
    {
      area: "Model-led tools",
      purpose: "Tools are explicit capabilities selected by the model; prefer improving schemas/results over hidden message-specific branching.",
      files: [
        "src/tools/registry.ts",
        "src/tools/coreTools.ts",
        "src/tools/agentTaskTools.ts",
        "src/tools/discordHistoryFormatting.ts",
        "src/tools/discordStatsFormatting.ts",
        "src/tools/types.ts",
        "src/agent/router.ts"
      ],
      checks: ["tests/unit/tool-registry.test.ts", "tests/unit/core-tools.test.ts", "tests/integration/agent.test.ts"]
    },
    {
      area: "Observability console",
      purpose: "Runs, spans, events, artifacts, and the React console explain what happened and where latency went.",
      files: ["src/observability/runs.ts", "src/control/internalApi.ts", "src/control/console/App.tsx", "src/control/console/styles.css"],
      checks: ["tests/unit/observability.test.ts", "tests/unit/internal-api-runs.test.ts", "tests/unit/run-console-timeline.test.ts"]
    },
    {
      area: "Architecture guides",
      purpose: "Repo-level and folder-level docs explain ownership boundaries so code updates can avoid broad source archaeology.",
      files: ["AGENTS.md", "docs/architecture.md", "docs/tool-design.md", "src/discord/README.md", "src/agent/README.md", "src/tools/README.md", "src/execution/README.md"],
      checks: []
    }
  ]);
  const suggestedCheckCommands = await buildSuggestedCheckCommands(checkoutDir, anchorTargetFiles);
  const firstMoveRules = [
    "Read AGENTS.md first when present.",
    ...(anchorTargetFiles.length
      ? [
          "Exact request anchors were found; inspect the top anchor target file first and make the first edit there before reading broad project-map files.",
          "Do not spend more than three targeted file reads before the first code diff when anchor targets exist."
        ]
      : []),
    "Batch the first reconnaissance pass: read the closest owner, nearest helper/caller, closest README, and closest test together when possible.",
    "Avoid repeated search/read cycles once the owner is clear; make the first patch, then let focused checks guide follow-up reads.",
    "Choose the owner from repository docs, folder READMEs, source names, and exact anchors; do not rely on generated lifecycle classification.",
    "After identifying the relevant flow, make the smallest useful test or implementation edit before doing broad repo archaeology.",
    "If the request describes a bug, prefer a focused regression test plus the smallest fix.",
    "If the request describes behavior or UX, update the behavior directly and cover the important contract with tests.",
    "Run only the closest relevant tests first; use npm run typecheck for TypeScript contract changes, and leave broad verification to CI.",
    "Stop when the requested behavior is implemented and the most relevant checks have run."
  ];

  return {
    repoGuidePath,
    repoGuideExcerpt,
    requestAnchors,
    anchorMatches,
    anchorTargetFiles,
    suggestedFiles: anchorTargetFiles,
    suggestedCheckCommands,
    sandboxContract: [
      "You are already inside an isolated Kubernetes sandbox with full filesystem/network access for this task.",
      "The checkout is a writable task branch. Edit files directly in the current repository.",
      "Do not create commits, push branches, open PRs, or mutate GitHub state; the sandbox runner handles that after your focused checks pass.",
      "Use helper CLIs by absolute shim path when useful: $AGENT_TOOL_SHIM_DIR/agent-task-context, $AGENT_TOOL_SHIM_DIR/agent-cache-info, $AGENT_TOOL_SHIM_DIR/agent-progress <step> <message>.",
      "Dependency cache is prepared before the harness runs. Inspect cache state with agent-cache-info only when relevant; do not reinstall dependencies unless package manifests changed.",
      "Use apply_patch for focused file edits when available; otherwise use the smallest reliable edit command.",
      "Prefer rg for search, then read only the files needed for the next concrete edit. If rg is unavailable, use the local search fallback or a minimal Node search rather than broad shell loops."
    ],
    firstMoveRules,
    projectMap
  };
}

async function existingProjectMap(checkoutDir: string, entries: CodegenContextPack["projectMap"]) {
  return Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      files: await existingRelativePaths(checkoutDir, entry.files),
      checks: await existingRelativePaths(checkoutDir, entry.checks)
    }))
  );
}

async function existingRelativePaths(checkoutDir: string, relativePaths: string[]) {
  const checks = await Promise.all(relativePaths.map(async (file) => ((await pathExists(path.join(checkoutDir, file))) ? file : null)));
  return checks.filter((file): file is string => Boolean(file));
}

async function readRepoGuideExcerpt(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return tail(content.trim(), MAX_REPO_GUIDE_EXCERPT);
  } catch {
    return undefined;
  }
}

async function buildSuggestedCheckCommands(checkoutDir: string, files: Array<{ path: string; reason: string }>) {
  const existingTests = uniqueStrings(files.map((file) => file.path).filter(isTestFilePath)).slice(0, 4);
  const commands: Array<{ command: string; reason: string }> = [];
  if (existingTests.length > 0) {
    commands.push({
      command: `npm test -- ${existingTests.map(shellQuoteArg).join(" ")}`,
      reason: "Run the closest focused tests for exact request anchors; avoid broad suites unless their output is directly needed."
    });
  }
  if (files.some((file) => isTypeScriptPath(file.path)) && (await pathExists(path.join(checkoutDir, "tsconfig.json")))) {
    commands.push({
      command: "npm run typecheck",
      reason: "Catch TypeScript contract breakage after focused edits; this should usually be the final local check."
    });
  }
  return commands;
}

function isTestFilePath(filePath: string) {
  return /^tests\/.+\.(?:test|spec)\.[cm]?[tj]sx?$/.test(filePath) || /(?:^|\/)__tests__\/.+\.[cm]?[tj]sx?$/.test(filePath);
}

function isTypeScriptPath(filePath: string) {
  return /\.[cm]?tsx?$/.test(filePath);
}

function shellQuoteArg(value: string) {
  return /^[A-Za-z0-9._/@:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
