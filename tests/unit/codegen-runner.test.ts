import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEGEN_REPO_CONTEXT_MAP,
  CODEGEN_REQUIRED_DEV_TOOLS,
  codegenCommandEnv,
  codegenPrompt,
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

  it("keeps a repository navigation map for common codegen tasks", () => {
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/discord/client.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/agent/router.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/tools/registry.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/tools/coreTools.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/db/repositories.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("src/codegen/runner.ts");
    expect(CODEGEN_REPO_CONTEXT_MAP).toContain("Ignore dist/ and node_modules/");
  });

  it("injects the repository map into Codex prompts before the user request", () => {
    const prompt = codegenPrompt({
      requestId: "codegen-123",
      request: "add better logging to Discord replies",
      updateName: "better-logging",
      requestedBy: "kartik (123)"
    });

    expect(prompt).toContain("Use the repository map below to choose the first files to inspect");
    expect(prompt).toContain(CODEGEN_REPO_CONTEXT_MAP);
    expect(prompt.indexOf(CODEGEN_REPO_CONTEXT_MAP)).toBeLessThan(prompt.indexOf("Requested update:"));
    expect(prompt).toContain("Request ID: codegen-123");
    expect(prompt).toContain("Requested by: kartik (123)");
    expect(prompt).toContain("add better logging to Discord replies");
  });
});
