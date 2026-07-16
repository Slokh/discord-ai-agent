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
  it("keeps the default scope minimal and adds retrieval only for Discord-history intent", () => {
    withEnv({ SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "", GITHUB_REPOSITORY: "owner/repo" }, () => {
      const config = loadConfig();
      expect([...selectToolGroups({ text: "hello there", hasImageAttachments: false, config })].sort()).toEqual(["core", "external"]);
      const groups = selectToolGroups({ text: "what happened in the server yesterday", hasImageAttachments: false, config });
      expect([...groups].sort()).toEqual(["core", "discord-retrieval", "external"]);
    });
  });

  it("always offers provably fair randomness even for vague follow-ups", () => {
    const config = loadConfig();
    const groups = selectToolGroups({ text: "20 more", hasImageAttachments: false, config });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("discord-action")).toBe(false);
    expect(tools.localTools.some((tool) => tool.name === "drawRandom")).toBe(true);
    expect(tools.localTools.some((tool) => tool.name === "createDiscordPoll")).toBe(false);
  });

  it("exposes the reveal tool for an explicit randomness reveal", () => {
    const config = loadConfig();
    const groups = selectToolGroups({ text: "Reveal randomness", hasImageAttachments: false, replyContext: true, config });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("discord-action")).toBe(true);
    expect(tools.localTools.some((tool) => tool.name === "revealRandomness")).toBe(true);
  });

  it("always pairs wallet-backed randomness with pause and settlement tools", () => {
    withEnv({
      WALLET_ENABLED: "true",
      USER_WALLETS_ENABLED: "true",
      PRIVY_APP_ID: "app",
      PRIVY_APP_SECRET: "secret"
    }, () => {
      const config = loadConfig();
      const tools = scopedToolset({ config, groups: new Set(["core", "external"]) });
      const names = tools.localTools.map((tool) => tool.name);

      expect(names).toContain("drawRandom");
      expect(names).toContain("awaitRandomWagerAction");
      expect(names).toContain("settleRandomWager");
    });
  });

  it("keeps bot balance reads while removing user-wallet actions and wager schema", () => {
    withEnv({
      WALLET_ENABLED: "true",
      USER_WALLETS_ENABLED: "false",
      PRIVY_APP_ID: "app",
      PRIVY_APP_SECRET: "secret"
    }, () => {
      const config = loadConfig();
      const tools = scopedToolset({ config, groups: new Set(["external", "discord-action"]) }).localTools;
      const names = tools.map((tool) => tool.name);
      const drawRandom = tools.find((tool) => tool.name === "drawRandom");
      const properties = drawRandom?.parameters.properties as Record<string, unknown>;

      expect(names).toContain("getWalletBalance");
      expect(names).not.toContain("listWalletBalances");
      expect(names).not.toContain("transferWalletFunds");
      expect(names).not.toContain("requestStarterFunds");
      expect(names).not.toContain("awaitRandomWagerAction");
      expect(names).not.toContain("settleRandomWager");
      expect(properties).not.toHaveProperty("wager");
    });
  });

  it("restores user-wallet tools and wager schema only when explicitly enabled", () => {
    withEnv({
      WALLET_ENABLED: "true",
      USER_WALLETS_ENABLED: "true",
      PRIVY_APP_ID: "app",
      PRIVY_APP_SECRET: "secret"
    }, () => {
      const config = loadConfig();
      const tools = scopedToolset({ config, groups: new Set(["external", "discord-action"]) }).localTools;
      const names = tools.map((tool) => tool.name);
      const drawRandom = tools.find((tool) => tool.name === "drawRandom");
      const properties = drawRandom?.parameters.properties as Record<string, unknown>;

      expect(names).toContain("getWalletBalance");
      expect(names).toContain("listWalletBalances");
      expect(names).toContain("transferWalletFunds");
      expect(names).toContain("requestStarterFunds");
      expect(names).toContain("adminTransferWalletFunds");
      expect(names).toContain("reconcileWalletTransfers");
      expect(names).toContain("awaitRandomWagerAction");
      expect(names).toContain("settleRandomWager");
      expect(properties).toHaveProperty("wager");
    });
  });

  it("adds image tools for visual intent even without the word image", () => {
    const groups = selectToolGroups({ text: "draw a wizard eating nachos", hasImageAttachments: false, config: loadConfig() });
    expect(groups.has("image")).toBe(true);
  });

  it("adds Discord file inspection for vague file follow-ups", () => {
    const config = loadConfig();
    const groups = selectToolGroups({
      text: "can you read the file itself or no?",
      hasImageAttachments: false,
      replyContext: true,
      config
    });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("discord-retrieval")).toBe(true);
    expect(tools.localTools.some((tool) => tool.name === "inspectDiscordFile")).toBe(true);
  });

  it("adds Discord file inspection for a generic reply with non-image attachments", () => {
    const config = loadConfig();
    const groups = selectToolGroups({
      text: "what is this",
      hasImageAttachments: false,
      hasFileAttachments: true,
      replyContext: true,
      config
    });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("discord-retrieval")).toBe(true);
    expect(groups.has("image")).toBe(false);
    expect(tools.localTools.some((tool) => tool.name === "inspectDiscordFile")).toBe(true);
  });

  it("adds requester-scoped retrieval for the bug inbox", () => {
    const config = loadConfig();
    const groups = selectToolGroups({ text: "show me my bug inbox", hasImageAttachments: false, config });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("discord-retrieval")).toBe(true);
    expect(groups.has("codegen")).toBe(false);
    expect(tools.localTools.some((tool) => tool.name === "listDiscordBugMarkers")).toBe(true);
  });

  it("adds retrieval and codegen when the requester asks to fix reacted-to bugs", () => {
    withEnv({
      GITHUB_REPOSITORY: "example-org/example-repo",
      GITHUB_TOKEN: "test-token",
      TASK_SIGNING_SECRET: "test-secret"
    }, () => {
      const config = loadConfig();
      const groups = selectToolGroups({
        text: "look at all the things I reacted to and fix them",
        hasImageAttachments: false,
        config
      });
      const tools = scopedToolset({ config, groups });

      expect(groups.has("discord-retrieval")).toBe(true);
      expect(groups.has("codegen")).toBe(true);
      expect(tools.localTools.some((tool) => tool.name === "listDiscordBugMarkers")).toBe(true);
      expect(tools.localTools.some((tool) => tool.name === "runCodingAgent")).toBe(true);
    });
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
    const config = loadConfig();
    const groups = selectToolGroups({ text: "change the bot avatar", hasImageAttachments: false, config });
    expect(groups.has("ops")).toBe(true);
    expect(groups.has("discord-action")).toBe(true);
    expect(groups.has("image")).toBe(true);
    expect(scopedToolset({ config, groups }).localTools.some((tool) => tool.name === "updateBotAvatar")).toBe(true);
  });

  it("offers server emoji creation for explicit emoji upload prompts", () => {
    const config = loadConfig();
    const groups = selectToolGroups({ text: "make a custom emoji of a nacho wizard", hasImageAttachments: false, config });
    expect(groups.has("ops")).toBe(true);
    expect(groups.has("discord-action")).toBe(true);
    expect(groups.has("image")).toBe(true);
    expect(scopedToolset({ config, groups }).localTools.some((tool) => tool.name === "createDiscordEmoji")).toBe(true);
  });

  it("keeps emoji lifecycle tools available in vague replies to an emoji result", () => {
    const config = loadConfig();
    const groups = selectToolGroups({
      text: "why does it not have a transparent background?",
      hasImageAttachments: true,
      replyContext: true,
      replyContextText: "Done! <:seahorse:1527428086201581678> is now live.",
      config,
    });

    expect(groups.has("ops")).toBe(true);
    expect(groups.has("discord-action")).toBe(true);
    expect(scopedToolset({ config, groups }).localTools.some((tool) => tool.name === "createDiscordEmoji")).toBe(true);
  });

  it("exposes avatar updates when a vague reply escalates to Discord actions", () => {
    const config = loadConfig();
    const tools = requestAdditionalToolGroups({
      requestedGroups: ["discord-action"],
      currentGroups: new Set(["core", "external", "image"]),
      config
    }).localTools;

    expect(tools.some((tool) => tool.name === "updateBotAvatar")).toBe(true);
  });

  it("offers direct run debugging for terse Discord replies", () => {
    const config = loadConfig();
    const groups = selectToolGroups({ text: "debug this", hasImageAttachments: false, replyContext: true, config });
    const tools = scopedToolset({ config, groups });

    expect(groups.has("ops")).toBe(true);
    expect(tools.localTools.some((tool) => tool.name === "inspectAgentLogs")).toBe(true);
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
      const requested = requestAdditionalToolGroups({ requestedGroups: ["spotify"], currentGroups: new Set(["core", "external"]), config });
      expect(requested.groups.has("spotify")).toBe(true);
      expect(requested.localTools.some((tool) => tool.name === "searchSpotify")).toBe(true);

      const all = requestAdditionalToolGroups({ currentGroups: new Set(["core", "external"]), config });
      expect(all.groups).toEqual(new Set(["core", "external", "discord-retrieval", "generated-data", "discord-action", "image", "spotify", "codegen", "ops"]));
      expect(all.localTools.some((tool) => tool.name === "runCodingAgent")).toBe(true);

      const invalid = requestAdditionalToolGroups({
        requestedGroups: ["discord-attachments", "discord-context"],
        currentGroups: new Set(["core", "external"]),
        config
      });
      expect(invalid.groups).toEqual(all.groups);
      expect(invalid.localTools.some((tool) => tool.name === "inspectDiscordFile")).toBe(true);
    });
  });
});
