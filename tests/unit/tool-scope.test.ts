import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { requestAdditionalToolGroups, scopedToolset, selectToolGroups } from "../../src/tools/toolScope.js";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("tool scoping", () => {
  it("always includes core, retrieval, and external tools", () => {
    withEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "", GITHUB_REPOSITORY: "owner/repo" }, () => {
      const groups = selectToolGroups({ text: "what happened yesterday", hasImageAttachments: false, config: loadConfig() });
      expect([...groups].sort()).toEqual(["core", "discord-retrieval", "external"]);
    });
  });

  it("adds image tools for visual intent even without the word image", () => {
    const groups = selectToolGroups({ text: "draw a wizard eating nachos", hasImageAttachments: false, config: loadConfig() });
    expect(groups.has("image")).toBe(true);
  });

  it("adds spotify only when credentials and music intent are present", () => {
    withEnv({ SPOTIFY_CLIENT_ID: "id", SPOTIFY_CLIENT_SECRET: "secret" }, () => {
      const config = loadConfig();
      expect(selectToolGroups({ text: "who is all over this playlist", hasImageAttachments: false, config }).has("spotify")).toBe(true);
    });
    withEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }, () => {
      const config = loadConfig();
      expect(selectToolGroups({ text: "spotify playlist stats", hasImageAttachments: false, config }).has("spotify")).toBe(false);
      expect(scopedToolset({ config, groups: new Set(["core", "spotify"]) }).localTools.some((tool) => tool.group === "spotify")).toBe(false);
    });
  });

  it("adds codegen for casual code-update intent when repo, credentials, and signing secret are configured", () => {
    withEnv({ GITHUB_REPOSITORY: "example-org/example-repo", GITHUB_TOKEN: "test-token", TASK_SIGNING_SECRET: "test-secret" }, () => {
      const groups = selectToolGroups({ text: "can you fix the bot test failure", hasImageAttachments: false, config: loadConfig() });
      expect(groups.has("codegen")).toBe(true);
    });
  });

  it("excludes codegen when GitHub credentials are missing even if the repo is set", () => {
    withEnv(
      {
        GITHUB_REPOSITORY: "example-org/example-repo",
        GITHUB_TOKEN: undefined,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_INSTALLATION_ID: undefined,
        TASK_SIGNING_SECRET: "test-secret"
      },
      () => {
        const config = loadConfig();
        expect(selectToolGroups({ text: "can you fix the bot test failure", hasImageAttachments: false, config }).has("codegen")).toBe(false);
        expect(scopedToolset({ config, groups: new Set(["core", "codegen"]) }).localTools.some((tool) => tool.group === "codegen")).toBe(false);
      }
    );
  });

  it("adds ops for bot administration", () => {
    const groups = selectToolGroups({ text: "change the bot avatar", hasImageAttachments: false, config: loadConfig() });
    expect(groups.has("ops")).toBe(true);
  });

  it("requestAdditionalTools expands to requested or all groups", () => {
    withEnv(
      {
        SPOTIFY_CLIENT_ID: "id",
        SPOTIFY_CLIENT_SECRET: "secret",
        GITHUB_REPOSITORY: "example-org/example-repo",
        GITHUB_TOKEN: "test-token",
        TASK_SIGNING_SECRET: "test-secret"
      },
      () => {
      const config = loadConfig();
      const requested = requestAdditionalToolGroups({ requestedGroups: ["spotify"], currentGroups: new Set(["core", "discord-retrieval", "external"]), config });
      expect(requested.groups.has("spotify")).toBe(true);
      expect(requested.localTools.some((tool) => tool.name === "searchSpotify")).toBe(true);

      const all = requestAdditionalToolGroups({ currentGroups: new Set(["core", "discord-retrieval", "external"]), config });
      expect(all.groups).toEqual(new Set(["core", "discord-retrieval", "external", "image", "spotify", "codegen", "ops"]));
      expect(all.localTools.some((tool) => tool.name === "runCodingAgent")).toBe(true);
    });
  });
});
