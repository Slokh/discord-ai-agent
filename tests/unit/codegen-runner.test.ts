import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEGEN_REQUIRED_DEV_TOOLS, codegenCommandEnv, missingCodegenDevTools } from "../../src/codegen/runner.js";

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
});
