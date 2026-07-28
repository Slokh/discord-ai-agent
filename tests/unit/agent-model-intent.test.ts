import { describe, expect, it } from "vitest";
import {
  agentModelIntentForPrompt,
  modelTargetFromCurrentContext,
} from "../../src/tools/agentModelIntent.js";
import type { ToolContext } from "../../src/tools/types.js";

describe("agent model intent", () => {
  it.each([
    ["switch model to moonshotai/kimi-k3", { action: "set", target: "moonshotai/kimi-k3" }],
    ["please set the chat model to <anthropic/claude-sonnet-5>", { action: "set", target: "anthropic/claude-sonnet-5" }],
    ["switch to sonnet5", { action: "set", target: "sonnet5" }],
    ["switch back to Kimi K3", { action: "set", target: "Kimi K3" }],
    ["use moonshotai/kimi-k3", { action: "set", target: "moonshotai/kimi-k3" }],
    ["Can you switch us to Sonnet 5, please?", { action: "set", target: "Sonnet 5" }],
    ["let's use Kimi K3", { action: "set", target: "Kimi K3" }],
    ["USE TOOL TO SWITXH MODEL TO SONNET 5", { action: "set", target: "SONNET 5" }],
    ["reset model", { action: "reset" }],
    ["switch the bot model back to the default", { action: "reset" }],
  ])("parses %s", (text, expected) => {
    expect(agentModelIntentForPrompt(text)).toEqual(expected);
  });

  it("separates a compound request from the model mutation", () => {
    expect(agentModelIntentForPrompt(
      "switch to sonnet5, then compare MacBook Air vs Neo for Georgia Tech OMSA",
    )).toEqual({
      action: "set",
      target: "sonnet5",
      continuationText: "compare MacBook Air vs Neo for Georgia Tech OMSA",
    });
  });

  it.each([
    "which model should we switch to?",
    "I literally added a tool for you to change models",
    "moonshotai/kimi-k3",
    "the model is good",
  ])("does not turn discussion or a bare name into mutation intent: %s", (text) => {
    expect(agentModelIntentForPrompt(text)).toBeNull();
  });

  it("resolves a contextual target only from requester-scoped reply/session context", () => {
    const ctx = {
      userId: "owner",
      replyContext: {
        content: "I found `anthropic/claude-sonnet-5`.",
        chain: [{
          content: "I found `anthropic/claude-sonnet-5`.",
          attachments: [],
        }],
      },
      sessionMessages: [{
        authorId: "someone-else",
        role: "user",
        content: "moonshotai/kimi-k2",
      }],
    } as unknown as ToolContext;

    expect(modelTargetFromCurrentContext(ctx, "that")).toBe("anthropic/claude-sonnet-5");
  });
});
