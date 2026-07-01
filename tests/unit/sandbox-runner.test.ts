import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildCodegenContextPack,
  codexExecArgs,
  codexResumeExecArgs,
  codeUpdatePrompt,
  codeUpdateRecoveryPrompt,
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
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "z-ai/glm-5.2",
      "-"
    ]);
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
          watchdogReason: "first_diff_deadline",
          stdoutTail: "looked at task notifications",
          stderrTail: ""
        }
      ]
    });
    expect(recovery).toContain("Do not restart broad analysis");
    expect(recovery).toContain("make the smallest focused test or implementation edit now");
    expect(recovery).toContain("first_diff_deadline");
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
