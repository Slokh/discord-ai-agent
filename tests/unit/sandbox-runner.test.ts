import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildCodegenContextPack,
  codegenFirstDiffDeadlineMs,
  codexConfigToml,
  codexExecArgs,
  codexHomePathForTask,
  codexResumeExecArgs,
  codeUpdatePrompt,
  codeUpdateRecoveryPrompt,
  evaluateCodegenWatchdog,
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

  it("keeps Codex home outside the temporary workspace when a persistent sandbox cache exists", () => {
    expect(
      codexHomePathForTask({
        sandboxCacheDir: "/var/cache/discord-ai-agent",
        workRoot: "/tmp/discord-ai-agent-workspaces/slokh-discord-ai-agent-156e554d18/task-PN8sBv"
      })
    ).toBe("/var/cache/discord-ai-agent/codex-home/task-PN8sBv");
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
          watchdogReason: "no_first_diff",
          stdoutTail: "looked at task notifications",
          stderrTail: ""
        }
      ]
    });
    expect(recovery).toContain("Do not restart broad analysis");
    expect(recovery).toContain("make the smallest focused test or implementation edit now");
    expect(recovery).toContain("no_first_diff");
  });

  it("guides Codex toward lifecycle-first implementation before broad exploration", () => {
    const prompt = codeUpdatePrompt({
      taskId: "task-1",
      requestedBy: "kartik",
      taskRequest: "Change the user-visible loading state."
    });

    expect(prompt).toContain("map the lifecycle before editing");
    expect(prompt).toContain("User wording may describe product behavior instead of exact code symbols");
    expect(prompt).toContain("map the phrase to the closest existing mechanism in the lifecycle");
    expect(prompt).toContain("trigger -> temporary state -> progress/update paths -> success response -> error/timeout/cancellation -> cleanup");
    expect(prompt).toContain("introduce or reuse a small abstraction that owns the lifecycle");
    expect(prompt).toContain("Preserve existing invariants that other code may depend on");
    expect(prompt).toContain("encode the requested behavior as a focused invariant");
    expect(prompt).toContain("stop searching for exact request vocabulary");
    expect(prompt).toContain("agent-progress first_edit");
    expect(prompt).toContain("Produce a real code diff promptly");
  });

  it("builds a code update status lifecycle context pack from product-language requests", async () => {
    const contextPack = await buildCodegenContextPack(
      process.cwd(),
      "Fix the bug where the bot's loading indicator for code update requests can stick around after the coding agent finishes."
    );

    expect(contextPack.focus).toBe("agent_task_status_lifecycle");
    expect(contextPack.likelyMechanisms).toEqual(
      expect.arrayContaining([
        expect.stringContaining("temporary/status reply"),
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
      expect(contextPack.focus).toBe("discord_interaction_lifecycle");
      expect(renderedContext).toContain("Concrete request anchors:");
      expect(renderedContext).toContain("Target files from exact request evidence:");
      expect(renderedContext).toContain("Concrete request anchors outrank broad lifecycle guesses");
      expect(renderedContext).toContain("Do not spend more than three targeted file reads before the first code diff");
      expect(prompt).toContain("If exact request anchor target files are present");
      expect(prompt).toContain("Patch-first budget:");
      expect(prompt).toContain("Use `apply_patch` for the first focused edit when available");
      expect(prompt).toContain("patch that owner before reading broad project-map files");
      expect(recovery).toContain("Patch-first targets from the original request anchors:");
      expect(recovery).toContain("Do not run more than one read/search command before the first patch");
      expect(recovery).toContain("Use apply_patch for the recovery edit when available");
      expect(recovery).toContain("src/discord/client.ts");
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

  it("fails early when Codex has not produced a diff", () => {
    expect(
      evaluateCodegenWatchdog({
        elapsedMs: 11 * 60 * 1000,
        idleMs: 30_000,
        hasDiff: false,
        reconnectSeen: false,
        reconnectStallMs: null
      })
    ).toEqual(expect.objectContaining({ action: "fail", reason: "no_first_diff" }));
  });

  it("continues to verification when Codex stalls after producing a diff", () => {
    expect(
      evaluateCodegenWatchdog({
        elapsedMs: 12 * 60 * 1000,
        idleMs: 6 * 60 * 1000,
        hasDiff: true,
        reconnectSeen: false,
        reconnectStallMs: null
      })
    ).toEqual(expect.objectContaining({ action: "continue", reason: "idle_after_diff" }));
  });

  it("uses a 10 minute no-first-diff deadline for normal, recovery, and anchored attempts", () => {
    expect(codegenFirstDiffDeadlineMs()).toBe(600_000);
    expect(codegenFirstDiffDeadlineMs(undefined, 2)).toBe(600_000);
    expect(codegenFirstDiffDeadlineMs({ anchorTargetFiles: [{ path: "src/discord/client.ts", reason: "exact anchor" }] })).toBe(600_000);
    expect(codegenFirstDiffDeadlineMs({ anchorTargetFiles: [{ path: "src/discord/client.ts", reason: "exact anchor" }] }, 2)).toBe(600_000);
  });

  it("treats reconnect stalls as retryable before a diff and salvageable after a diff", () => {
    expect(
      evaluateCodegenWatchdog({
        elapsedMs: 6 * 60 * 1000,
        idleMs: 60_000,
        hasDiff: false,
        reconnectSeen: true,
        reconnectStallMs: 3 * 60 * 1000,
        noFirstDiffTimeoutMs: 10 * 60 * 1000
      })
    ).toEqual(expect.objectContaining({ action: "fail", reason: "reconnect_stall" }));

    expect(
      evaluateCodegenWatchdog({
        elapsedMs: 6 * 60 * 1000,
        idleMs: 60_000,
        hasDiff: true,
        reconnectSeen: true,
        reconnectStallMs: 3 * 60 * 1000,
        noFirstDiffTimeoutMs: 10 * 60 * 1000
      })
    ).toEqual(expect.objectContaining({ action: "continue", reason: "reconnect_stall" }));
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
