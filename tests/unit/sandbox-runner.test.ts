import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { codexExecArgs, repairWorktreeRemoteForBranchPush } from "../../src/execution/sandboxRunner.js";

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
      "--ephemeral",
      "-C",
      "/tmp/work/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "z-ai/glm-5.2",
      "-"
    ]);
    expect(args).not.toContain("--ask-for-approval");
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
