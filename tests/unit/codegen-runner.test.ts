import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEGEN_COMMAND_WARNING_THRESHOLD,
  CODEGEN_REPO_CONTEXT_MAP,
  CODEGEN_PROMPT_COMMAND_BUDGET,
  CODEGEN_REQUIRED_DEV_TOOLS,
  CODEGEN_WORK_ROOT_DIR,
  changedFilesFromGitStatus,
  codexExecArgs,
  codegenCommandEnv,
  codegenPrompt,
  codegenPullRequestTitle,
  pullRequestBody,
  missingCodegenDevTools
} from "../../src/codegen/runner.js";

describe("codegen runner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("forces ephemeral checkout commands to install and use dev dependencies", () => {
    const env = codegenCommandEnv({
      NODE_ENV: "production",
      NPM_CONFIG_OMIT: "dev",
      npm_config_omit: "dev",
      GITHUB_TOKEN: "token"
    });

    expect(env.NODE_ENV).toBe("development");
    expect(env.NPM_CONFIG_INCLUDE).toBe("dev");
    expect(env.NPM_CONFIG_OMIT).toBe("");
    expect(env.NPM_CONFIG_PRODUCTION).toBe("false");
    expect(env.npm_config_include).toBe("dev");
    expect(env.npm_config_omit).toBe("");
    expect(env.npm_config_production).toBe("false");
    expect(env.GITHUB_TOKEN).toBe("token");
  });

  it("reports missing required dev tool binaries before Codex runs", async () => {
    const checkoutDir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-ai-agent-codegen-test-"));
    tempDirs.push(checkoutDir);
    await fs.mkdir(path.join(checkoutDir, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(checkoutDir, "node_modules", ".bin", "tsx"), "");

    await expect(missingCodegenDevTools(checkoutDir)).resolves.toEqual(CODEGEN_REQUIRED_DEV_TOOLS.filter((tool) => tool !== "tsx"));
  });

  it("runs Codex exec in JSON event mode for activity logging", () => {
    expect(codexExecArgs({ checkoutDir: "/tmp/repo", model: "test/model" })).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--ephemeral",
      "-C",
      "/tmp/repo",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      "test/model",
      "-"
    ]);
  });

  it("keeps a repository navigation map for common codegen tasks", () => {
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/discord/client.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/agent/router.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/tools/registry.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/tools/coreTools.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/db/repositories.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/codegen/runner.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("Ignore dist/ and node_modules/");
  });

  it("uses a non-temp local work root so Codex helper aliases can be created", () => {
    expect(CODEGEN_WORK_ROOT_DIR).toBe(".codegen-runs");
  });

  it("keeps command budget constants aligned between tracing and prompting", () => {
    expect(CODEGEN_COMMAND_WARNING_THRESHOLD).toBeGreaterThanOrEqual(CODEGEN_PROMPT_COMMAND_BUDGET);
  });

  it("injects the repository map into Codex prompts before the user request", () => {
    const prompt = codegenPrompt({
      requestId: "codegen-123",
      request: "add better logging to Discord replies",
      updateName: "better-logging",
      requestedBy: "kartik (123)"
    });

    expect(prompt).toContain("Use the repository map below to choose the first files to inspect");
    expect(prompt).toContain("Use apply_patch for manual source edits");
    expect(prompt).toContain(`If you reach about ${CODEGEN_PROMPT_COMMAND_BUDGET} commands`);
    expect(prompt).toContain("Do not run full `npm test`");
    expect(prompt).toContain("the harness runs full verification after you exit");
    expect(prompt).toContain(CODEGEN_REPO_CONTEXT_MAP);
    expect(prompt.indexOf(CODEGEN_REPO_CONTEXT_MAP)).toBeLessThan(prompt.indexOf("Requested update:"));
    expect(prompt).toContain("Request ID: codegen-123");
    expect(prompt).toContain("Requested by: kartik (123)");
    expect(prompt).toContain("add better logging to Discord replies");
  });

  it("uses the requested task as the pull request title", () => {
    expect(codegenPullRequestTitle("Fix: Split long Discord replies into chunks")).toBe("Fix: Split long Discord replies into chunks");
    expect(codegenPullRequestTitle("\n\n## Add codegen observability docs\nmore detail")).toBe("Add codegen observability docs");
    expect(codegenPullRequestTitle("a".repeat(120))).toHaveLength(100);
  });

  it("formats generated pull request bodies with product-focused sections", () => {
    const body = pullRequestBody({
      job: {
        requestId: "codegen-123",
        request: "Fix long Discord replies.",
        updateName: "long-replies",
        requestedBy: "kartik"
      },
      model: "z-ai/glm-5.2",
      verifyPassed: false,
      changedFiles: ["src/discord/client.ts", "tests/unit/discord-client.test.ts"]
    });

    expect(body).toContain("## Why\n\nFix long Discord replies.");
    expect(body).toContain("## Changes\n\n- Updated `src/discord/client.ts`.\n- Updated `tests/unit/discord-client.test.ts`.");
    expect(body).toContain("## Testing\n\n- `npm run verify`: failed; opened as draft\n- `npm run scan:release`: passed");
    expect(body).toContain("## Context\n\n- Prompted by: kartik\n- Request ID: `codegen-123`\n- Model: `z-ai/glm-5.2`");
    expect(body).not.toContain("## Agent Codegen");
    expect(body).not.toContain("## Requested Update");
  });

  it("extracts changed files from git porcelain status", () => {
    expect(changedFilesFromGitStatus(" M README.md\n?? tests/new.test.ts\nR  old.ts -> src/new.ts\n")).toEqual([
      "README.md",
      "tests/new.test.ts",
      "src/new.ts"
    ]);
  });
});
