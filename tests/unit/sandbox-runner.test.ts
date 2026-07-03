import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildCodegenContextPack,
  codegenNpmInstallEnv,
  codegenNpmScriptEnv,
  codexConfigToml,
  codexExecArgs,
  codexHomePathForTask,
  codexResumeExecArgs,
  codeUpdateBranchName,
  codeUpdatePullRequestBody,
  codeUpdatePullRequestTitle,
  codeUpdatePrompt,
  codeUpdateRecoveryPrompt,
  diagnoseCodegenFailure,
  dependencyCacheKey,
  fetchOpenCodeHealth,
  openCodeConfigJson,
  openCodeModelId,
  openCodeRunArgs,
  openCodeServeArgs,
  renderCodegenFailureDiagnosis,
  renderCodegenContextPack,
  repairWorktreeRemoteForBranchPush
} from "../../src/execution/sandboxRunner.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
}

describe("sandboxRunner", () => {
  it("runs Codex with full access inside the external Kubernetes sandbox", () => {
    const args = codexExecArgs({ checkoutDir: "/tmp/work/repo", model: "z-ai/glm-5.2" });

    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      "/tmp/work/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "z-ai/glm-5.2",
      "-"
    ]);
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("--ephemeral");
  });

  it("resumes the persisted Codex session for recovery attempts", () => {
    expect(codexResumeExecArgs({ model: "z-ai/glm-5.2" })).toEqual([
      "exec",
      "resume",
      "--last",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "z-ai/glm-5.2",
      "-"
    ]);
  });

  it("writes a Centaur-like Codex harness profile", () => {
    const config = codexConfigToml({ checkoutDir: "/tmp/work/repo", model: "openai/gpt-5.5" });

    expect(config).toContain('model = "openai/gpt-5.5"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('sandbox_mode = "danger-full-access"');
    expect(config).toContain('model_reasoning_effort = "low"');
    expect(config).toContain('model_verbosity = "low"');
    expect(config).toContain('personality = "pragmatic"');
    expect(config).toContain('service_tier = "fast"');
    expect(config).toContain("[features]");
    expect(config).toContain("fast_mode = true");
    expect(config).toContain("runtime_metrics = true");
    expect(config).toContain("[model_providers.openrouter]");
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('[projects."/tmp/work/repo"]');
    expect(config).toContain('trust_level = "trusted"');
  });

  it("builds OpenCode server and run commands from the shared codegen model", () => {
    expect(openCodeModelId("z-ai/glm-5.2")).toBe("openrouter/z-ai/glm-5.2");
    expect(openCodeModelId("openrouter/z-ai/glm-5.2")).toBe("openrouter/z-ai/glm-5.2");
    expect(openCodeServeArgs(4123)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "4123"]);
    expect(
      openCodeRunArgs({
        serverUrl: "http://127.0.0.1:4123",
        checkoutDir: "/tmp/work/repo",
        model: "z-ai/glm-5.2",
        title: "Update the README",
        prompt: "Please edit the README."
      })
    ).toEqual([
      "run",
      "--attach",
      "http://127.0.0.1:4123",
      "--model",
      "openrouter/z-ai/glm-5.2",
      "--format",
      "json",
      "--title",
      "Update the README",
      "Please edit the README."
    ]);
    expect(JSON.parse(openCodeConfigJson({ model: "z-ai/glm-5.2" }))).toEqual({
      $schema: "https://opencode.ai/config.json",
      model: "openrouter/z-ai/glm-5.2"
    });
  });

  it("times out a hung OpenCode health probe", async () => {
    const server = createServer(() => {
      // Deliberately leave the request open to match a half-ready server.
    });
    const serverUrl = await new Promise<string>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to bind test server."));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    try {
      const startedAt = Date.now();
      await expect(fetchOpenCodeHealth({ serverUrl, timeoutMs: 25 })).rejects.toThrow("OpenCode health probe timed out");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps Codex home outside the temporary workspace when a persistent sandbox cache exists", () => {
    expect(
      codexHomePathForTask({
        sandboxCacheDir: "/var/cache/discord-ai-agent",
        workRoot: "/tmp/discord-ai-agent-workspaces/slokh-discord-ai-agent-156e554d18/task-PN8sBv"
      })
    ).toBe("/var/cache/discord-ai-agent/codex-home/task-PN8sBv");
  });

  it("uses concise ai-prefixed branch names for code updates", () => {
    expect(codeUpdateBranchName("Use loading reaction instead of Thinking reply", "task-demo-1234-abcd5678")).toBe(
      "ai/use-loading-reaction-thinking-reply-5678"
    );
  });

  it("humanizes legacy kebab task titles before opening PRs", () => {
    expect(codeUpdatePullRequestTitle("instead-of-replying-with-a-thinking-placeholder--retry")).toBe(
      "Instead of replying with a thinking placeholder"
    );
  });

  it("keeps generated PR bodies focused with prompted-by in the footer", () => {
    const body = codeUpdatePullRequestBody({
      env: {
        taskRequest: "Use a loading reaction while the bot is working.",
        requestedBy: "demo-user (100000000000000001)"
      }
    });

    expect(body).toBe(
      [
        "## Why",
        "",
        "Use a loading reaction while the bot is working.",
        "",
        "## Changes",
        "",
        "- Implemented by the Discord AI Agent sandbox.",
        "- See the PR diff for the exact code changes.",
        "",
        "## Testing",
        "",
        "- Agent ran focused checks in the sandbox where applicable.",
        "- `npm run scan:release`: passed",
        "- Full verification is handled by CI after the PR opens.",
        "",
        "---",
        "",
        "Prompted by: demo-user (100000000000000001)"
      ].join("\n")
    );
    expect(body).not.toContain("## Context");
    expect(body).not.toContain("Task ID");
    expect(body).not.toContain("Codegen model");
  });

  it("classifies terminal codegen failures with actionable next steps", () => {
    const noDiff = diagnoseCodegenFailure({
      error: new Error("Agent task produced no diff after OpenCode attempt; no PR will be opened."),
      timings: { repo: 120, opencode: 20_000, total: 21_000 },
      harness: "opencode"
    });

    expect(noDiff).toEqual(
      expect.objectContaining({
        category: "no_diff",
        status: "no_changes",
        failedPhase: "opencode",
        slowestPhase: { name: "opencode", durationMs: 20_000 }
      })
    );
    expect(noDiff.summary).toContain("OpenCode finished but left the repository with no code diff");
    expect(noDiff.nextAction).toContain("request context");

    const scan = diagnoseCodegenFailure({
      error: new Error("Release scan failed after agent task; refusing to push generated changes."),
      timings: { repo: 100, scan: 2500, total: 3000 },
      harness: "codex"
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
  });

  it("builds a concise codegen context pack from the repository guide and project map", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-context-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "tools"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "src", "jobs"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "guide\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "tools", "coreTools.ts"), "export {}\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "jobs", "queue.ts"), "export {}\n", "utf8");

      const context = await buildCodegenContextPack(tempDir);
      const rendered = renderCodegenContextPack(context);

      expect(context.repoGuidePath).toBe("AGENTS.md");
      expect(rendered).toContain("Read AGENTS.md first");
      expect(rendered).toContain("src/tools/coreTools.ts");
      expect(rendered).toContain("src/jobs/queue.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("includes repo guide excerpts and exact focused check commands in the context pack", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-context-checks-"));
    try {
      await fs.mkdir(path.join(tempDir, "src", "tools"), { recursive: true });
      await fs.mkdir(path.join(tempDir, "tests", "unit"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "AGENTS.md"), "Use rg first.\nAdd focused regression tests.\n", "utf8");
      await fs.writeFile(path.join(tempDir, "tsconfig.json"), '{"compilerOptions":{}}\n', "utf8");
      await fs.writeFile(path.join(tempDir, "src", "tools", "registry.ts"), "export {}\n", "utf8");
      await fs.writeFile(path.join(tempDir, "src", "tools", "coreTools.ts"), "export {}\n", "utf8");
      await fs.writeFile(path.join(tempDir, "tests", "unit", "tool-registry.test.ts"), "export {}\n", "utf8");
      await fs.writeFile(path.join(tempDir, "tests", "unit", "core-tools.test.ts"), "export {}\n", "utf8");

      const context = await buildCodegenContextPack(tempDir, "Improve the tool schema for Discord history search.");
      const rendered = renderCodegenContextPack(context);
      const prompt = codeUpdatePrompt(
        {
          taskId: "task-1",
          requestedBy: "kartik",
          taskRequest: "Improve the tool schema for Discord history search."
        },
        context
      );

      expect(context.repoGuideExcerpt).toContain("Use rg first.");
      expect(context.suggestedCheckCommands).toEqual([
        {
          command: "npm test -- tests/unit/tool-registry.test.ts tests/unit/core-tools.test.ts",
          reason: "Run the closest focused tests for the suggested source/test area before broader checks."
        },
        {
          command: "npm run typecheck",
          reason: "Catch repository-wide TypeScript contract breakage after focused edits."
        }
      ]);
      expect(rendered).toContain("Repository guide excerpt:");
      expect(rendered).toContain("> Add focused regression tests.");
      expect(rendered).toContain("Suggested focused checks:");
      expect(rendered).toContain("npm test -- tests/unit/tool-registry.test.ts tests/unit/core-tools.test.ts");
      expect(prompt).toContain("Run the suggested focused checks from the preflight context");
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
    expect(initial).toContain("Use the preflight context as a starting map");
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

  it("guides Codex toward lifecycle-first implementation before broad exploration", () => {
    const prompt = codeUpdatePrompt({
      taskId: "task-1",
      requestedBy: "kartik",
      taskRequest: "Change the user-visible loading state."
    });

    expect(prompt).toContain("map it to the lifecycle");
    expect(prompt).toContain("trigger -> acknowledgement/status -> work -> success response -> error path -> cleanup");
    expect(prompt).toContain("Prefer a small shared lifecycle owner");
    expect(prompt).toContain("Inspect the likely owner, nearest caller/helper, and closest test");
    expect(prompt).toContain("$AGENT_TOOL_SHIM_DIR/agent-progress first_edit");
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
      CODEGEN_HARNESS: "opencode",
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
    expect(env.CODEGEN_HARNESS).toBeUndefined();
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

  it("builds a code update status lifecycle context pack from product-language requests", async () => {
    const contextPack = await buildCodegenContextPack(
      process.cwd(),
      "Fix the bug where the bot's loading indicator for code update requests can stick around after the coding agent finishes."
    );

    expect(contextPack.focus).toBe("agent_task_status_lifecycle");
      expect(contextPack.likelyMechanisms).toEqual(
        expect.arrayContaining([
          expect.stringContaining("response sink"),
          expect.stringContaining("task notifier"),
          expect.stringContaining("Terminal task rendering")
        ])
      );
    expect(contextPack.suggestedFiles?.map((file) => file.path)).toEqual(
      expect.arrayContaining(["src/discord/taskNotifications.ts", "src/tools/coreTools.ts"])
    );
    expect(contextPack.firstInvariant).toContain("without leaving stale loading/progress text after completion");
    expect(contextPack.suggestedFirstEdit).toContain("focused task notification or repository test");
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
        'Replace the "Thinking..." placeholder reply behavior with a loading reaction. When processing a prompt, instead of sending a "Thinking..." message, react to the user\'s original message with the animated loading emoji <a:loading:1521299407214084337>. Once the final response is ready, remove the loading reaction from the user\'s message and reply as normal.';

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
      expect(contextPack.focus).toBe("discord_response_lifecycle");
      expect(renderedContext).toContain("Concrete request anchors:");
      expect(renderedContext).toContain("Target files from exact request evidence:");
      expect(renderedContext).toContain("Concrete request anchors outrank broad lifecycle guesses");
      expect(renderedContext).toContain("Do not spend more than three targeted file reads before the first code diff");
      expect(prompt).toContain("If exact request anchors or target files are present");
      expect(prompt).toContain("patch the owning source file");
      expect(prompt).toContain("Prefer a small shared lifecycle owner");
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

  it("includes the focused context pack in the Codex prompt", async () => {
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

    expect(renderedContext).toContain("Focus: agent_task_status_lifecycle");
    expect(prompt).toContain("Codegen preflight context:");
    expect(prompt).toContain("Focus: agent_task_status_lifecycle");
    expect(prompt).toContain("Concrete anchors from the request outrank broad lifecycle guesses");
    expect(prompt).toContain("First implementable invariant:");
    expect(prompt).toContain("Suggested first edit:");
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
      await git(checkoutDir, ["checkout", "-b", "generated-update"]);

      const mirrorConfig = await git(checkoutDir, ["config", "--get", "remote.origin.mirror"]);
      expect(mirrorConfig.stdout.trim()).toBe("true");
      await expect(git(checkoutDir, ["push", "origin", "HEAD:test-before-repair"])).rejects.toMatchObject({
        stderr: expect.stringContaining("--mirror can't be combined with refspecs")
      });

      await repairWorktreeRemoteForBranchPush({ checkoutDir, repoUrl: remoteDir });

      await expect(git(checkoutDir, ["config", "--get", "remote.origin.mirror"])).rejects.toBeTruthy();
      await git(checkoutDir, ["push", "origin", "HEAD:test-after-repair"]);
      const pushedRef = await git(tempDir, ["--git-dir", remoteDir, "show-ref", "--verify", "refs/heads/test-after-repair"]);
      expect(pushedRef.stdout).toContain("refs/heads/test-after-repair");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
