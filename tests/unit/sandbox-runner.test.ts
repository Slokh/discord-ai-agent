import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  codeUpdatePrompt,
  codeUpdateRecoveryPrompt,
  renderCodegenContextPack,
} from "../../src/execution/codegenPrompts.js";
import {
  CodegenTaskError,
  diagnoseCodegenFailure,
  renderCodegenFailureDiagnosis,
} from "../../src/execution/codegenFailureDiagnosis.js";
import { buildCodegenContextPack } from "../../src/execution/contextPack.js";
import {
  codegenNpmInstallEnv,
  codegenNpmScriptEnv,
  dependencyCacheKey,
} from "../../src/execution/dependencyCache.js";
import {
  nanoCodexModel,
  nanoCodexProcessEnv,
} from "../../src/execution/harness/nanocodex.js";
import {
  codeUpdateBranchName,
  codeUpdatePullRequestMetadata,
  deterministicPullRequestMetadata,
  codeUpdatePullRequestTitle,
} from "../../src/execution/prFormatting.js";
import {
  branchPushRef,
  codeUpdateTargetFromInputs,
  readGitChangeState,
  repairWorktreeRemoteForBranchPush
} from "../../src/execution/repoWorkspace.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
}

describe("sandboxRunner", () => {
  it("runs only NanoCodex-supported models through the native runtime", () => {
    expect(nanoCodexModel("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(nanoCodexModel("openai/gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(nanoCodexModel("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(() => nanoCodexModel("openrouter/openai/gpt-5.6-luna")).toThrow(/supports OpenRouter model/);
    expect(() => nanoCodexModel("z-ai/glm-5.2")).toThrow(/supports OpenRouter model/);
    const env = nanoCodexProcessEnv(
      { PATH: "/usr/bin" },
      "/tmp/tool-shims"
    );
    expect(env).toEqual(
      expect.objectContaining({
        PATH: `/tmp/tool-shims${path.delimiter}/usr/bin`,
        AGENT_TOOL_SHIM_DIR: "/tmp/tool-shims",
      })
    );
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("treats question-plus-change codegen prompts as implementation requests", () => {
    const prompt = codeUpdatePrompt({
      taskId: "task-1",
      requestedBy: "User (u)",
      taskRequest: "where is this defined and can we increase it?"
    });

    expect(prompt).toContain("answer the question by implementing the reasonable change");
    expect(prompt).toContain("Do not stop at investigation unless the user explicitly asks for read-only diagnosis.");
    expect(prompt).toContain("where is this defined");
  });

  it("gives read-only repository diagnosis an explicit no-diff contract", () => {
    const prompt = codeUpdatePrompt({
      taskType: "diagnosis",
      taskId: "task-2",
      requestedBy: "User (u)",
      taskRequest: "Explain why this CI job is slow without changing files."
    });
    expect(prompt).toContain("read-only diagnosis");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Keep the checkout unchanged");
  });

  it("installs GitHub CLI in the sandbox runtime image", async () => {
    const dockerfile = await fs.readFile(path.join(process.cwd(), "Dockerfile"), "utf8");
    const cargoManifest = await fs.readFile(path.join(process.cwd(), "native/nanocodex-runtime/Cargo.toml"), "utf8");

    expect(dockerfile).toContain("https://cli.github.com/packages");
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends gh");
    expect(dockerfile).toContain("npm install --global npm@11.19.0");
    expect(dockerfile).not.toContain("nanocodex-bin");
    expect(cargoManifest).toContain("9da913aeed3361b708cca8308e016125b84b9430");
    expect(dockerfile).toContain("/usr/local/bin/discord-agent-nanocodex-runtime");
    expect(dockerfile).not.toContain("/usr/local/bin/nanocodex");
  });

  it("uses concise agent-prefixed branch names for code updates", () => {
    expect(codeUpdateBranchName("Use loading reaction instead of Thinking reply", "task-demo-1234-abcd5678")).toBe(
      "agent/use-loading-reaction-thinking-reply-5678"
    );
  });

  it("humanizes legacy kebab task titles before opening PRs", () => {
    expect(codeUpdatePullRequestTitle("instead-of-replying-with-a-thinking-placeholder--retry")).toBe(
      "Instead of replying with a thinking placeholder"
    );
  });

  it("derives specific PR metadata from only the public code diff", async () => {
    const prompts: string[] = [];
    const metadata = await codeUpdatePullRequestMetadata({
      diffStat: [
        " src/agent/nanocodexAgentRuntime.ts | 75 ++++++++++++++++++----------",
        " tests/unit/nanocodex-agent-runtime.test.ts | 53 ++++++++++++++++++++",
        " 2 files changed, 105 insertions(+), 23 deletions(-)",
      ].join("\n"),
      diffPatch: [
        "diff --git a/src/agent/nanocodexAgentRuntime.ts b/src/agent/nanocodexAgentRuntime.ts",
        "--- a/src/agent/nanocodexAgentRuntime.ts",
        "+++ b/src/agent/nanocodexAgentRuntime.ts",
        "@@ -1,3 +1,4 @@",
        "+eventName: \"agent.nanocodex.timeout_output_recovered\"",
        "diff --git a/tests/unit/nanocodex-agent-runtime.test.ts b/tests/unit/nanocodex-agent-runtime.test.ts",
        "--- a/tests/unit/nanocodex-agent-runtime.test.ts",
        "+++ b/tests/unit/nanocodex-agent-runtime.test.ts",
        "+it(\"delivers generated files when the hard timeout wins\", async () => {})",
      ].join("\n"),
      complete: async ({ systemPrompt, userPrompt }) => {
        prompts.push(systemPrompt, userPrompt);
        return {
          content: JSON.stringify({
            title: "Recover generated files after agent runtime timeouts",
            why: "Generated files could be lost when the runtime timed out after a file-producing tool completed.",
            changes: [
              "Return accumulated files and presentation metadata after timeout.",
              "Cover both runtime exits and hard-timeout recovery paths.",
            ],
          }),
          model: "openai/gpt-5.6-terra",
          estimatedCostUsd: 0.002,
        };
      },
    });

    expect(metadata).toEqual(expect.objectContaining({
      title: "Recover generated files after agent runtime timeouts",
      source: "diff_model",
      model: "openai/gpt-5.6-terra",
      estimatedCostUsd: 0.002,
    }));
    expect(metadata.body).toBe(
      [
        "## Why",
        "",
        "Generated files could be lost when the runtime timed out after a file-producing tool completed.",
        "",
        "## Changes",
        "",
        "- Return accumulated files and presentation metadata after timeout.",
        "- Cover both runtime exits and hard-timeout recovery paths.",
        "",
        "## Testing",
        "",
        "- `npm run typecheck`: passed",
        "- `npm run scan:release`: passed",
        "- Required pull-request checks provide the remaining repository verification."
      ].join("\n")
    );
    expect(prompts.join("\n")).toContain("timeout_output_recovered");
    expect(prompts.join("\n")).not.toContain("private-request-marker");
    expect(prompts.join("\n")).not.toContain("Requested by");
  });

  it("samples large PR diffs across early and late changed files", async () => {
    const sections = Array.from({ length: 300 }, (_, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      `+marker-${index}-${"x".repeat(900)}`,
    ].join("\n"));
    let capturedPrompt = "";
    await codeUpdatePullRequestMetadata({
      diffStat: "80 files changed",
      diffPatch: sections.join("\n"),
      complete: async ({ userPrompt }) => {
        capturedPrompt = userPrompt;
        return { content: JSON.stringify({ title: "Update sampled files", why: "The implementation changes many files.", changes: ["Apply the sampled changes."] }) };
      },
    });

    expect(capturedPrompt).toContain("src/file-0.ts");
    expect(capturedPrompt).toContain("src/file-150.ts");
    expect(capturedPrompt).toContain("src/file-299.ts");
    expect(capturedPrompt).toContain("diff sampled across changed files");
  });

  it("falls back to changed source paths instead of bug-report metadata", async () => {
    const diffPatch = "diff --git a/src/agent/nanocodexAgentRuntime.ts b/src/agent/nanocodexAgentRuntime.ts\n+recovery";
    const fallback = deterministicPullRequestMetadata("1 file changed, 1 insertion(+)", diffPatch);
    expect(fallback.title).toBe("Improve NanoCodex agent runtime");
    expect(fallback.body).toContain("`src/agent/nanocodexAgentRuntime.ts`");

    const metadata = await codeUpdatePullRequestMetadata({
      diffStat: "1 file changed, 1 insertion(+)",
      diffPatch,
      complete: async () => ({
        content: JSON.stringify({
          title: "Validate Discord bug report private-request-marker",
          why: "Validate the report.",
          changes: ["Implement the requested change."],
        }),
      }),
    });
    expect(metadata).toEqual(expect.objectContaining({
      title: "Improve NanoCodex agent runtime",
      source: "deterministic_fallback",
      fallbackReason: expect.stringContaining("generic"),
    }));

    const genericBody = await codeUpdatePullRequestMetadata({
      diffStat: "1 file changed, 1 insertion(+)",
      diffPatch,
      complete: async () => ({
        content: JSON.stringify({
          title: "Recover generated runtime files",
          why: "Implement the requested repository change.",
          changes: ["Update the required files."],
        }),
      }),
    });
    expect(genericBody.source).toBe("deterministic_fallback");
  });

  it("classifies terminal codegen failures with actionable next steps", () => {
    const noDiff = diagnoseCodegenFailure({
      error: new CodegenTaskError("no_diff", "nanocodex", "Agent task produced no diff after NanoCodex attempt; no PR will be opened."),
      timings: { repo: 120, nanocodex: 20_000, total: 21_000 }
    });

    expect(noDiff).toEqual(
      expect.objectContaining({
        category: "no_diff",
        status: "no_changes",
        failedPhase: "nanocodex",
        slowestPhase: { name: "nanocodex", durationMs: 20_000 }
      })
    );
    expect(noDiff.summary).toContain("NanoCodex finished but left the repository with no code diff");
    expect(noDiff.nextAction).toContain("repository navigation context");

    const scan = diagnoseCodegenFailure({
      error: new CodegenTaskError("release_scan", "scan", "Release scan failed after agent task; refusing to push generated changes."),
      timings: { repo: 100, scan: 2500, total: 3000 }
    });

    expect(scan).toEqual(
      expect.objectContaining({
        category: "release_scan",
        status: "failed",
        failedPhase: "scan"
      })
    );
    expect(renderCodegenFailureDiagnosis(scan)).toContain("Category: release_scan");
    expect(renderCodegenFailureDiagnosis(scan)).toContain("- scan: 2.5s");

    const verification = diagnoseCodegenFailure({
      error: new CodegenTaskError("verification", "typecheck", "TypeScript verification failed after agent task; refusing to publish generated changes."),
      timings: { typecheck: 5_000, total: 6_000 }
    });
    expect(verification).toEqual(expect.objectContaining({
      category: "verification",
      status: "failed",
      failedPhase: "typecheck"
    }));
  });

  it("classifies typed no-diff failures without parsing command output", () => {
    const error = Object.assign(new Error("Agent task produced no diff after NanoCodex attempt; no PR will be opened."), {
      name: "CodegenNoDiffError",
      attempts: [
        {
          attempt: 1,
          command: "nanocodex-run",
          exitCode: 0,
          durationMs: 12_000,
          producedDiff: false,
          finalResponse: "I found the config but did not edit it.",
          stdoutTail: "NanoCodex read files and described a plan.",
          stderrTail: ""
        }
      ]
    });

    const diagnosis = diagnoseCodegenFailure({
      error,
      timings: { nanocodex: 12_000, total: 13_000 }
    });

    expect(diagnosis).toEqual(
      expect.objectContaining({
        category: "no_diff",
        status: "no_changes",
        failedPhase: "nanocodex"
      })
    );
    expect(diagnosis.summary).toContain("no code diff");
    expect(diagnosis.nextAction).toContain("repository navigation context");
    expect(diagnosis.finalResponse).toBe("I found the config but did not edit it.");
    expect(renderCodegenFailureDiagnosis(diagnosis)).toContain("## Attempts");
    expect(renderCodegenFailureDiagnosis(diagnosis)).toContain("## Harness Final Answer");
    expect(renderCodegenFailureDiagnosis(diagnosis)).toContain("I found the config but did not edit it.");
    expect(renderCodegenFailureDiagnosis(diagnosis)).toContain("attempt 1: command=nanocodex-run");
  });

  it("keeps no-diff failures with edit signals in the normal no-diff category", () => {
    const error = Object.assign(new Error("Agent task produced no diff after NanoCodex attempt; no PR will be opened."), {
      name: "CodegenNoDiffError",
      attempts: [
        {
          attempt: 1,
          command: "nanocodex-run",
          exitCode: 0,
          durationMs: 15_000,
          producedDiff: false,
          stdoutTail: '{"type":"tool_use","part":{"tool":"edit","title":"src/example.ts"}}',
          stderrTail: ""
        }
      ]
    });

    expect(
      diagnoseCodegenFailure({
        error,
        timings: { nanocodex: 15_000, total: 16_000 }
      })
    ).toEqual(expect.objectContaining({ category: "no_diff", status: "no_changes" }));
  });

  it("builds a concise codegen context pack from the repository guide and project map", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-context-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "tools"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "src", "jobs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "guide\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "tools", "registry.ts"), "export {}\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "jobs", "queue.ts"), "export {}\n", "utf8");

      const context = await buildCodegenContextPack(tempDir);
      const rendered = renderCodegenContextPack(context);

      expect(context.repoGuidePath).toBe("AGENTS.md");
      expect(rendered).toContain("Read AGENTS.md first");
      expect(rendered).toContain("src/tools/registry.ts");
      expect(rendered).toContain("src/jobs/queue.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes repo guide excerpts and exact-anchor check commands in the context pack", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-context-checks-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "discord"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "tests", "unit"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "Use rg first.\nAdd focused regression tests.\n", "utf8");
      await fs.writeFile(path.join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}\n', "utf8");
      await fs.writeFile(path.join(tempDir, "src", "discord", "client.ts"), 'export const placeholder = "Thinking...";\n', "utf8");
      await fs.writeFile(path.join(tempDir, "tests", "unit", "discord-client.test.ts"), 'expect("Thinking...").toBeTruthy();\n', "utf8");

      const context = await buildCodegenContextPack(tempDir, 'Replace the "Thinking..." placeholder reply behavior.');
      const rendered = renderCodegenContextPack(context);
      const prompt = codeUpdatePrompt(
        {
          taskId: "task-1",
          requestedBy: "kartik",
          taskRequest: 'Replace the "Thinking..." placeholder reply behavior.'
        },
        context
      );

      expect(context.repoGuideExcerpt).toContain("Use rg first.");
      expect(context.suggestedCheckCommands).toEqual([
        {
          command: "npm test -- tests/unit/discord-client.test.ts",
          reason: "Run the closest focused tests for exact request anchors; avoid broad suites unless their output is directly needed."
        },
        {
          command: "npm run typecheck",
          reason: "Catch TypeScript contract breakage after focused edits; this should usually be the final local check."
        }
      ]);
      expect(rendered).toContain("Repository guide excerpt:");
      expect(rendered).toContain("> Add focused regression tests.");
      expect(rendered).toContain("Suggested anchor checks:");
      expect(rendered).toContain("npm test -- tests/unit/discord-client.test.ts");
      expect(prompt).toContain("Run suggested anchor checks");
      expect(prompt).toContain("Validation ladder");
      expect(prompt).toContain("Do not run `npm run verify` or broad test suites");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("puts repo guidance and first-edit pressure in the initial and recovery prompts", () => {
    const env = {
      taskId: "task-1",
      requestedBy: "test-user",
      taskRequest: "fix loading indicator sticking around after codegen finishes"
    };
    const context = {
      repoGuidePath: "AGENTS.md",
      sandboxContract: ["Edit files directly in the current repository."],
      firstMoveRules: ["Read AGENTS.md first when present.", "Make a focused regression test early."],
      projectMap: [
        {
          area: "Code-update task lifecycle",
          purpose: "Tracks code update requests through Discord progress and PRs.",
          files: ["src/discord/taskNotifications.ts"],
          checks: ["tests/unit/task-notifications.test.ts"]
        }
      ]
    };

    const initial = codeUpdatePrompt(env as any, context);
    expect(initial).toContain("If AGENTS.md exists, read it before editing");
    expect(initial).toContain("Use repository guides, exact anchors, and the project map as navigation aids");
    expect(initial).toContain("Batch initial reconnaissance");
    expect(initial).toContain("Make a focused regression test early");
    expect(initial).toContain("src/discord/taskNotifications.ts");

    const recovery = codeUpdateRecoveryPrompt(env as any, {
      attempt: 2,
      totalAttempts: 2,
      gitStatus: "",
      attempts: [
        {
          attempt: 1,
          command: "exec",
          exitCode: 143,
          durationMs: 480_000,
          producedDiff: false,
          stdoutTail: "looked at task notifications",
          stderrTail: ""
        }
      ]
    });
    expect(recovery).toContain("Do not restart broad analysis");
    expect(recovery).toContain("make the smallest focused test or implementation edit now");
    expect(recovery).toContain("looked at task notifications");
  });

  it("guides the coding agent toward repo-owned implementation before broad exploration", () => {
    const prompt = codeUpdatePrompt({
      taskId: "task-1",
      requestedBy: "kartik",
      taskRequest: "Change the user-visible loading state."
    });

    expect(prompt).toContain("Let the repository concept guides, source ownership, exact anchors, and tests determine the implementation path");
    expect(prompt).toContain("Batch initial reconnaissance");
    expect(prompt).toContain("Do not keep alternating search/read/search/read");
    expect(prompt).toContain("$AGENT_TOOL_SHIM_DIR/agent-progress first_edit");
  });

  it("includes a built-in GitHub CI debugging skill for sandboxed code updates", () => {
    const prompt = codeUpdatePrompt({
      taskId: "task-ci",
      requestedBy: "kartik",
      taskRequest: "Debug the failing CI on PR #111 and fix it."
    });

    expect(prompt).toContain("Built-in skill: GitHub CI debugging");
    expect(prompt).toContain("gh pr checks <pr>");
    expect(prompt).toContain("gh run view <run-id> --log-failed");
    expect(prompt).toContain("Prefer failed job log excerpts and local reproduction over guessing from the PR diff alone.");
    expect(prompt).toContain("The sandbox runner handles pushing and opening/updating the PR.");
    expect(prompt).toContain("Do not commit, push, open a PR, or edit GitHub state yourself.");
  });

  it("forces codegen dependency installs to include dev dependencies even under production service env", () => {
    const env = codegenNpmInstallEnv({
      ...process.env,
      NODE_ENV: "production",
      NPM_CONFIG_PRODUCTION: "true",
      npm_config_production: "true",
      NPM_CONFIG_OMIT: "dev",
      npm_config_omit: "dev"
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.NPM_CONFIG_PRODUCTION).toBe("false");
    expect(env.npm_config_production).toBe("false");
    expect(env.NPM_CONFIG_OMIT).toBeUndefined();
    expect(env.npm_config_omit).toBeUndefined();
  });

  it("strips runtime app configuration from generated npm verification commands", () => {
    const env = codegenNpmScriptEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      NODE_ENV: "production",
      NPM_CONFIG_PRODUCTION: "true",
      npm_config_omit: "dev",
      OPENROUTER_API_KEY: "sk-test",
      GITHUB_TOKEN: "ghp-test",
      DATABASE_URL: "postgres://example",
      TASK_REQUEST: "update the bot",
      SANDBOX_RUN_ID: "run-123",
      DISCORD_AI_AGENT_PROCESS_ROLE: "worker"
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp/home");
    expect(env.NODE_ENV).toBe("development");
    expect(env.NPM_CONFIG_PRODUCTION).toBeUndefined();
    expect(env.npm_config_omit).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.TASK_REQUEST).toBeUndefined();
    expect(env.SANDBOX_RUN_ID).toBeUndefined();
    expect(env.DISCORD_AI_AGENT_PROCESS_ROLE).toBeUndefined();
  });

  it("includes dev dependency mode in the dependency cache key", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-dependency-cache-"));
    try {
      await fs.writeFile(path.join(tempDir, "package.json"), '{"scripts":{},"devDependencies":{"vitest":"1.0.0"}}\n', "utf8");
      await fs.writeFile(path.join(tempDir, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n', "utf8");

      await expect(dependencyCacheKey(tempDir)).resolves.toMatch(/^node-\d+\.\d+\.\d+-devdeps-v1-[a-f0-9]{24}$/);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not inject lifecycle classifier focus for product-language codegen requests", async () => {
    const contextPack = await buildCodegenContextPack(
      process.cwd(),
      "Fix the bug where the bot's loading indicator for code update requests can stick around after the coding agent finishes."
    );
    const renderedContext = renderCodegenContextPack(contextPack);

    expect("focus" in contextPack).toBe(false);
    expect(renderedContext).not.toContain("Focus:");
    expect(renderedContext).toContain("Code-update task lifecycle");
    expect(renderedContext).toContain("Discord mention and reply lifecycle");
  });

  it("exposes durable knowledge owners through the stable project map without lifecycle classification", async () => {
    const taskRequest = [
      "Fully exclude channel ID 123456789012345678 (#example-channel) from all current and future knowledge.",
      "Remove indexed messages, embeddings, message index, search index, stats, everything.",
      "Ensure searchDiscordHistory, getRecentDiscordMessages, getDiscordStats, summarizeDiscordHistory, getDiscordChannelTopics, searchDiscordAttachments, and any other retrieval tool filters out this channel."
    ].join(" ");

    const contextPack = await buildCodegenContextPack(process.cwd(), taskRequest);
    const renderedContext = renderCodegenContextPack(contextPack);

    expect("focus" in contextPack).toBe(false);
    expect(contextPack.requestAnchors).not.toEqual(expect.arrayContaining(["searchDiscordHistory", "getDiscordStats", "searchDiscordAttachments"]));
    expect(renderedContext).not.toContain("Focus:");
    expect(renderedContext).toContain("Discord knowledge, indexing, and retrieval");
    expect(renderedContext).toContain("src/db/discordArchiveRepository.ts");
    expect(renderedContext).toContain("src/db/retrievalRepository.ts");
    expect(renderedContext).toContain("src/discord/crawler.ts");
    expect(renderedContext).toContain("src/discord/messagePersistence.ts");
  });

  it("keeps tool names as anchors when the request is actually about tool schemas", async () => {
    const taskRequest = "Improve the tool schema and tool description for searchDiscordHistory so the model chooses the right tool arguments.";

    const contextPack = await buildCodegenContextPack(process.cwd(), taskRequest);
    const renderedContext = renderCodegenContextPack(contextPack);

    expect("focus" in contextPack).toBe(false);
    expect(renderedContext).not.toContain("Focus:");
    expect(contextPack.requestAnchors).toEqual(expect.arrayContaining(["searchDiscordHistory"]));
    expect(renderedContext).toContain("Model-led tools");
  });

  it("prioritizes exact request anchors before broad lifecycle guesses", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-anchor-context-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "discord"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "src", "tools"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src", "discord", "client.ts"),
        'export async function reply() { return message.reply("Thinking..."); }\n',
        "utf8"
      );
      await fs.writeFile(path.join(tempDir, "src", "tools", "coreTools.ts"), "export {}\n", "utf8");
      const taskRequest =
        'Replace the "Thinking..." placeholder reply behavior with a loading reaction. When processing a prompt, instead of sending a "Thinking..." message, react to the user\'s original message with the animated loading emoji <a:loading:123456789012345678>. Once the final response is ready, remove the loading reaction from the user\'s message and reply as normal.';

      const contextPack = await buildCodegenContextPack(tempDir, taskRequest);
      const renderedContext = renderCodegenContextPack(contextPack);
      const prompt = codeUpdatePrompt(
        {
          taskId: "task-1",
          requestedBy: "kartik",
          taskRequest
        },
        contextPack
      );
      const recovery = codeUpdateRecoveryPrompt(
        {
          taskId: "task-1",
          requestedBy: "kartik",
          taskRequest
        } as any,
        {
          attempt: 2,
          totalAttempts: 2,
          attempts: [],
          gitStatus: "",
          contextPack
        }
      );

      expect(contextPack.requestAnchors).toContain("Thinking...");
      expect(contextPack.requestAnchors?.some((anchor) => anchor.includes("message and reply as normal"))).toBe(false);
      expect(contextPack.anchorMatches).toEqual(
        expect.arrayContaining([expect.objectContaining({ anchor: "Thinking...", file: "src/discord/client.ts", line: 1 })])
      );
      expect(contextPack.anchorTargetFiles?.[0]?.path).toBe("src/discord/client.ts");
      expect(contextPack.suggestedFiles?.[0]?.path).toBe("src/discord/client.ts");
      expect("focus" in contextPack).toBe(false);
      expect(renderedContext).toContain("Concrete request anchors:");
      expect(renderedContext).toContain("Target files from exact request evidence:");
      expect(renderedContext).toContain("Concrete request anchors are narrow evidence");
      expect(renderedContext).toContain("Do not spend more than three targeted file reads before the first code diff");
      expect(prompt).toContain("If exact request anchors or target files are present");
      expect(prompt).toContain("patch the owning source file");
      expect(prompt).toContain("Let the repository concept guides, source ownership, exact anchors, and tests determine the implementation path");
      expect(recovery).toContain("Patch-first targets from the original request anchors:");
      expect(recovery).toContain("Do not run more than one read/search command before the first patch");
      expect(recovery).toContain("Use apply_patch for the recovery edit when available");
      expect(recovery).toContain("src/discord/client.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers source owners over tests when both match the same exact request anchor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-anchor-owner-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "discord"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "tests", "unit"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src", "discord", "client.ts"),
        'export async function reply() { return message.reply("Thinking..."); }\n',
        "utf8"
      );
      await fs.writeFile(
        path.join(tempDir, "tests", "unit", "run-console-timeline.test.ts"),
        [
          'expect(timelineSummaryText("Sent Thinking reply")).toBe("");',
          'expect(timelineTitleText({ title: "Thinking reply sent" } as any)).toBe("Acknowledgement sent");',
          'expect(rendered).toContain("Thinking...");',
          ""
        ].join("\n"),
        "utf8"
      );

      const contextPack = await buildCodegenContextPack(tempDir, 'Replace the "Thinking..." placeholder reply behavior.');

      expect(contextPack.anchorTargetFiles?.map((file) => file.path).slice(0, 2)).toEqual([
        "src/discord/client.ts",
        "tests/unit/run-console-timeline.test.ts"
      ]);
      expect(contextPack.suggestedFiles?.[0]?.path).toBe("src/discord/client.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes repository navigation context in the coding prompt without lifecycle focus", async () => {
    const contextPack = await buildCodegenContextPack(process.cwd(), "Fix code update loading status after completion.");
    const renderedContext = renderCodegenContextPack(contextPack);
    const prompt = codeUpdatePrompt(
      {
        taskId: "task-1",
        requestedBy: "kartik",
        taskRequest: "Fix code update loading status after completion."
      },
      contextPack
    );

    expect(renderedContext).not.toContain("Focus:");
    expect(renderedContext).toContain("Project map:");
    expect(renderedContext).toContain("Code-update task lifecycle");
    expect(prompt).toContain("Repository navigation context:");
    expect(prompt).not.toContain("Focus:");
    expect(prompt).not.toContain("First implementable invariant:");
    expect(prompt).not.toContain("Suggested first edit:");
  });

  it("repairs mirror-backed worktree remotes so branch refspec pushes work", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-runner-"));
    try {
      const remoteDir = path.join(tempDir, "remote.git");
      const seedDir = path.join(tempDir, "seed");
      const mirrorDir = path.join(tempDir, "mirror.git");
      const checkoutDir = path.join(tempDir, "checkout");

      await git(tempDir, ["init", "--bare", "--initial-branch=main", remoteDir]);
      await git(tempDir, ["init", "--initial-branch=main", seedDir]);
      await fs.writeFile(path.join(seedDir, "README.md"), "seed\n", "utf8");
      await git(seedDir, ["add", "README.md"]);
      await git(seedDir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "seed"
      ]);
      await git(seedDir, ["remote", "add", "origin", remoteDir]);
      await git(seedDir, ["push", "origin", "main"]);

      await git(tempDir, ["clone", "--mirror", remoteDir, mirrorDir]);
      await git(tempDir, ["--git-dir", mirrorDir, "worktree", "add", "--detach", checkoutDir, "refs/heads/main"]);
      await git(checkoutDir, ["checkout", "-b", "ai/generated-update"]);

      const mirrorConfig = await git(checkoutDir, ["config", "--get", "remote.origin.mirror"]);
      expect(mirrorConfig.stdout.trim()).toBe("true");
      await expect(git(checkoutDir, ["push", "origin", "HEAD:test-before-repair"])).rejects.toMatchObject({
        stderr: expect.stringContaining("--mirror can't be combined with refspecs")
      });

      await repairWorktreeRemoteForBranchPush({ checkoutDir, repoUrl: remoteDir });

      await expect(git(checkoutDir, ["config", "--get", "remote.origin.mirror"])).rejects.toBeTruthy();
      await git(checkoutDir, ["push", "origin", `HEAD:${branchPushRef("ai/test-after-repair")}`]);
      const pushedRef = await git(tempDir, ["--git-dir", remoteDir, "show-ref", "--verify", "refs/heads/ai/test-after-repair"]);
      expect(pushedRef.stdout).toContain("refs/heads/ai/test-after-repair");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses structured target PR details instead of generating a new branch", () => {
    expect(
      codeUpdateTargetFromInputs({
        generatedBranchName: "ai/generated-fix-1234",
        targetBranch: "ai/reuse-existing-pr-branch-follow-up-7ad0",
        targetPullRequestNumber: 120,
        targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
      })
    ).toEqual({
      generatedBranchName: "ai/generated-fix-1234",
      branchName: "ai/reuse-existing-pr-branch-follow-up-7ad0",
      pullRequestNumber: 120,
      pullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120",
      updateExistingBranch: true
    });
  });

  it("extracts a PR number from a structured target pull request URL", () => {
    expect(
      codeUpdateTargetFromInputs({
        generatedBranchName: "ai/generated-fix-1234",
        targetPullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120"
      })
    ).toEqual({
      generatedBranchName: "ai/generated-fix-1234",
      branchName: "ai/generated-fix-1234",
      pullRequestNumber: 120,
      pullRequestUrl: "https://github.com/example/discord-ai-agent/pull/120",
      updateExistingBranch: true
    });
  });

  it("treats harness-created commits as generated code changes even when the working tree is clean", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-committed-change-"));
    try {
      await git(tempDir, ["init", "--initial-branch=main"]);
      await fs.writeFile(path.join(tempDir, "README.md"), "seed\n", "utf8");
      await git(tempDir, ["add", "README.md"]);
      await git(tempDir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "seed"
      ]);
      const baseRevision = (await git(tempDir, ["rev-parse", "HEAD"])).stdout.trim();
      await git(tempDir, ["checkout", "-b", "agent-task"]);
      await fs.writeFile(path.join(tempDir, "README.md"), "seed\nagent edit\n", "utf8");
      await git(tempDir, ["add", "README.md"]);
      await git(tempDir, [
        "-c",
        "user.name=Harness",
        "-c",
        "user.email=harness@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "harness edit"
      ]);

      const changeState = await readGitChangeState(tempDir, baseRevision);

      expect(changeState.status.trim()).toBe("");
      expect(changeState.hasWorkingTreeChanges).toBe(false);
      expect(changeState.hasCommittedChanges).toBe(true);
      expect(changeState.hasChanges).toBe(true);
      expect(changeState.commitsAhead).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
