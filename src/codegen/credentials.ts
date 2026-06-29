import fs from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config/env.js";

export type CodegenCredentialProvider = {
  assertAvailable: () => void;
  githubToken: () => string;
  gitAuthEnv: (workRoot: string) => Promise<NodeJS.ProcessEnv>;
  codexEnv: (input: { baseEnv: NodeJS.ProcessEnv; workRoot: string }) => NodeJS.ProcessEnv;
};

export class AppConfigCodegenCredentialProvider implements CodegenCredentialProvider {
  constructor(private readonly config: AppConfig) {}

  assertAvailable() {
    if (!this.config.github.token) {
      throw new Error("GITHUB_TOKEN is required for Railway-native agent codegen.");
    }
    if (!this.config.openRouter.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for Railway-native agent codegen.");
    }
  }

  async gitAuthEnv(workRoot: string) {
    this.assertAvailable();
    const token = this.githubToken();
    const askPassPath = path.join(workRoot, "git-askpass.sh");
    await fs.writeFile(
      askPassPath,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  *Username*) printf '%s\\n' x-access-token ;;",
        "  *) printf '%s\\n' \"$GIT_TOKEN\" ;;",
        "esac",
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    return {
      ...process.env,
      GIT_ASKPASS: askPassPath,
      GIT_TERMINAL_PROMPT: "0",
      GIT_TOKEN: token
    };
  }

  githubToken() {
    this.assertAvailable();
    const token = this.config.github.token;
    if (!token) throw new Error("GITHUB_TOKEN is required for Railway-native agent codegen.");
    return token;
  }

  codexEnv(input: { baseEnv: NodeJS.ProcessEnv; workRoot: string }) {
    this.assertAvailable();
    const apiKey = this.config.openRouter.apiKey;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for Railway-native agent codegen.");
    return {
      ...input.baseEnv,
      CODEX_HOME: path.join(input.workRoot, ".codex"),
      OPENROUTER_API_KEY: apiKey,
      npm_config_yes: "true"
    };
  }
}
