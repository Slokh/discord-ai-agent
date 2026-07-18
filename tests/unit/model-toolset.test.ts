import { describe, expect, it } from "vitest";
import {
  currentScopedToolset,
  expandToolsetState,
  handleAdditionalToolsRequest,
  initialToolsetState,
  type ToolsetState,
} from "../../src/agent/modelToolset.js";
import type { AgentToolRoute } from "../../src/agent/routerShared.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    config: {
      maxReplyChars: 1800,
      toolsetScoping: true,
      openRouter: {},
    },
    requestAttachments: [],
    ...overrides,
  } as unknown as ToolContext;
}

function requestAdditionalToolsRoute(
  args?: Record<string, unknown>,
): AgentToolRoute {
  return {
    id: "tool-call-1",
    name: "requestAdditionalTools",
    arguments: args,
    argumentsText: JSON.stringify(args ?? {}),
  };
}

describe("model toolset", () => {
  it("starts with every group when scoping is disabled", () => {
    const state = initialToolsetState(
      context({
        config: {
          maxReplyChars: 1800,
          toolsetScoping: false,
          openRouter: {},
        } as ToolContext["config"],
      }),
      "hello",
    );

    expect(state.expandedAll).toBe(true);
    expect(state.groups).toEqual(
      new Set([
        "core",
        "discord-retrieval",
        "generated-data",
        "presentation",
        "discord-action",
        "image",
        "spotify",
        "codegen",
        "ops",
        "external",
      ]),
    );
  });

  it("selects a minimal scoped toolset and always exposes provably fair randomness", () => {
    const ctx = context();
    const state = initialToolsetState(ctx, "hello there");
    const tools = currentScopedToolset(ctx, state);
    expect(currentScopedToolset(ctx, state)).toBe(tools);

    expect(state).toEqual({
      groups: new Set(["core", "external"]),
      expandedAll: false,
    });
    expect(tools.localTools.some((tool) => tool.name === "drawRandom")).toBe(
      true,
    );
  });

  it("distinguishes image attachments from generic replied files", () => {
    const requestState = initialToolsetState(
      context({
        requestAttachments: [
          {
            id: "image-1",
            url: "https://cdn.example.test/attachment",
            contentType: "image/png",
          },
        ],
      }),
      "what is this?",
    );
    const replyState = initialToolsetState(
      context({
        replyContext: {
          messageId: "reply-1",
          rootMessageId: "reply-1",
          channelId: "channel-1",
          guildId: "guild-1",
          authorId: "user-1",
          authorDisplayName: "User",
          authorIsBot: false,
          content: "see attached",
          attachmentSummaries: [],
          attachments: [],
          createdAt: null,
          url: null,
          chain: [
            {
              messageId: "reply-1",
              channelId: "channel-1",
              guildId: "guild-1",
              authorId: "user-1",
              authorDisplayName: "User",
              authorIsBot: false,
              content: "see attached",
              attachmentSummaries: [],
              attachments: [
                {
                  id: "attachment-1",
                  url: "https://cdn.example.test/file.bin",
                },
              ],
              createdAt: null,
              url: null,
            },
          ],
        },
      }),
      "inspect the reply",
    );

    expect(requestState.groups.has("image")).toBe(true);
    expect(replyState.groups.has("image")).toBe(false);
    expect(replyState.groups.has("discord-retrieval")).toBe(true);
    expect(currentScopedToolset(context(), replyState).localTools.some((tool) => tool.name === "inspectDiscordFile")).toBe(true);
  });

  it("describes requested additional tools and supplies a default reason", () => {
    const response = handleAdditionalToolsRequest(
      context(),
      requestAdditionalToolsRoute({ groups: ["image"] }),
      { groups: new Set(["core", "external"]), expandedAll: false },
    );

    expect(response.content).toContain(
      "Additional tool groups enabled: core, external, image.",
    );
    expect(response.content).toContain("generateImage");
    expect(response.content).toContain("Reason: No reason provided.");
  });

  it("preserves a supplied reason when all tool groups are requested", () => {
    const response = handleAdditionalToolsRequest(
      context(),
      requestAdditionalToolsRoute({ reason: "Need a broader capability." }),
      { groups: new Set(["core", "external"]), expandedAll: false },
    );

    expect(response.content).toContain("Reason: Need a broader capability.");
    expect(response.content).toContain("discord-retrieval");
  });

  it("expands all groups when a request contains unknown groups", () => {
    const initial: ToolsetState = {
      groups: new Set(["core", "external"]),
      expandedAll: false,
    };

    expect(
      expandToolsetState(initial, {
        groups: ["image", "discord-action", "not-a-group"],
      }),
    ).toEqual({
      groups: new Set([
        "core",
        "external",
        "discord-retrieval",
        "generated-data",
        "presentation",
        "discord-action",
        "image",
        "spotify",
        "codegen",
        "ops",
      ]),
      expandedAll: true,
    });
    expect(initial.groups).toEqual(new Set(["core", "external"]));
  });

  it("reports invalid-only requests and exposes Discord file inspection", () => {
    const ctx = context();
    const route = requestAdditionalToolsRoute({
      groups: ["discord-attachments", "discord-context"],
      reason: "Need to read the replied-to file.",
    });
    const initial: ToolsetState = {
      groups: new Set(["core", "external"]),
      expandedAll: false,
    };

    const response = handleAdditionalToolsRequest(ctx, route, initial);
    const expanded = expandToolsetState(initial, route.arguments);

    expect(response.content).toContain("Unrecognized groups (discord-attachments, discord-context)");
    expect(response.content).toContain("inspectDiscordFile");
    expect(expanded.groups.has("discord-retrieval")).toBe(true);
    expect(expanded.expandedAll).toBe(true);
  });

  it("expands to all groups when no specific group is requested", () => {
    const expanded = expandToolsetState(
      { groups: new Set(["core", "external"]), expandedAll: false },
      undefined,
    );

    expect(expanded.groups).toEqual(
      new Set([
        "core",
        "external",
        "discord-retrieval",
        "generated-data",
        "presentation",
        "discord-action",
        "image",
        "spotify",
        "codegen",
        "ops",
      ]),
    );
    expect(expanded.expandedAll).toBe(true);
  });
});
