import { describe, expect, it } from "vitest";
import { codegenCommandEnv } from "../../src/codegen/runner.js";

describe("codegen runner", () => {
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
});
