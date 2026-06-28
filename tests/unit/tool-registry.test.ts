import { describe, expect, it } from "vitest";
import { openRouterServerToolRegistry, renderToolList, toolDefinitionsForModel, toolRegistry } from "../../src/tools/registry.js";

describe("toolRegistry", () => {
  it("contains the local milestone tools", () => {
    expect(toolRegistry.map((tool) => tool.name)).toEqual([
      "listTools",
      "findDiscordUsers",
      "findDiscordChannels",
      "findDiscordRoles",
      "searchDiscordHistory",
      "getRecentDiscordMessages",
      "getDiscordMessageContext",
      "searchDiscordAttachments",
      "getPinnedMessages",
      "getDiscordStats",
      "analyzeDiscordData",
      "getDiscordChannelTopics",
      "summarizeDiscordHistory",
      "summarizeDiscordThread",
      "generateImage",
      "createSkillDraft",
      "openGithubPullRequest",
      "inspectAgentLogs",
      "inspectRailwayLogs",
      "reportStatus"
    ]);
  });

  it("renders a user-visible tool list", () => {
    expect(renderToolList()).toContain("searchDiscordHistory");
    expect(renderToolList()).toContain("Generate an image");
    expect(renderToolList()).toContain("web_search");
  });

  it("exports OpenRouter-compatible local function and server tool definitions", () => {
    expect(toolDefinitionsForModel()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "searchDiscordHistory",
            parameters: expect.objectContaining({
              type: "object",
              required: ["query"],
              properties: expect.objectContaining({
                authorIds: expect.objectContaining({ type: "array" }),
                authorQueries: expect.objectContaining({ type: "array" }),
                channelIds: expect.objectContaining({ type: "array" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "openrouter:web_search"
        }),
        expect.objectContaining({
          type: "openrouter:datetime"
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getDiscordStats",
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                groupBy: expect.objectContaining({ enum: expect.arrayContaining(["channel", "thread", "message", "month", "hourOfDay"]) }),
                metric: expect.objectContaining({ enum: expect.arrayContaining(["messages", "attachments", "reactions", "messagesPerChannelDay"]) }),
                sort: expect.objectContaining({ enum: expect.arrayContaining(["countDesc", "countAsc"]) })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "analyzeDiscordData",
            parameters: expect.objectContaining({
              required: ["task"],
              properties: expect.objectContaining({
                task: expect.objectContaining({ type: "string" }),
                query: expect.objectContaining({ type: "string" }),
                sampleLimit: expect.objectContaining({ type: "number" }),
                resultLimit: expect.objectContaining({ type: "number" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "getDiscordChannelTopics",
            parameters: expect.objectContaining({
              properties: expect.objectContaining({
                channelLimit: expect.objectContaining({ type: "number" }),
                topicsPerChannel: expect.objectContaining({ type: "number" })
              })
            })
          })
        }),
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({
            name: "summarizeDiscordHistory",
            parameters: expect.objectContaining({
              required: ["question"],
              properties: expect.objectContaining({
                authorIds: expect.objectContaining({ type: "array" }),
                sampleLimit: expect.objectContaining({ type: "number" })
              })
            })
          })
        })
      ])
    );
  });

  it("enables the initial hosted OpenRouter tools", () => {
    expect(openRouterServerToolRegistry.map((tool) => tool.type)).toEqual([
      "openrouter:web_search",
      "openrouter:web_fetch",
      "openrouter:datetime"
    ]);
  });
});
