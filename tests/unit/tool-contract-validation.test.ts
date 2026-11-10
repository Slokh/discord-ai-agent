import { describe, expect, it } from "vitest";
import { assertToolRegistryContractsValid, invalidToolCallResponse, validateToolCallArguments } from "../../src/tools/toolContractValidation.js";
import { loadConfig } from "../../src/config/env.js";

describe("tool contract validation", () => {
  it("compiles every model-facing local tool schema", () => {
    expect(() => assertToolRegistryContractsValid()).not.toThrow();
  });

  it("uses the advertised schema as the runtime argument boundary", () => {
    expect(validateToolCallArguments({ name: "findDiscordUsers", arguments: { query: "kartik" }, argumentsText: '{"query":"kartik"}' })).toEqual({ ok: true });
    expect(validateToolCallArguments({ name: "findDiscordUsers", arguments: {}, argumentsText: "{}" })).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("required") }));
    expect(validateToolCallArguments({ name: "findDiscordUsers", arguments: { query: "kartik", surprise: true }, argumentsText: '{"query":"kartik","surprise":true}' })).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining("additional properties") }));
  });

  it("rejects malformed or non-object JSON even for argument-free tools", () => {
    expect(validateToolCallArguments({ name: "loadSkillContext", arguments: {}, argumentsText: "not-json" }).ok).toBe(false);
    expect(validateToolCallArguments({ name: "loadSkillContext", arguments: {}, argumentsText: "[]" }).ok).toBe(false);
  });

  it("rejects empty and whitespace-only required strings", () => {
    for (const [name, argumentsValue] of [
      ["generateImage", { prompt: "" }],
      ["findDiscordUsers", { query: "" }],
      ["getDiscordMessageContext", { messageIdOrUrl: "\t" }],
    ] as const) {
      expect(validateToolCallArguments({
        name,
        arguments: argumentsValue,
        argumentsText: JSON.stringify(argumentsValue),
      }).ok).toBe(false);
    }
  });

  it("validates against the same deployment-narrowed schema shown to the model", () => {
    const base = loadConfig();
    const wager = { playerUserId: "user-1", stakeUsd: 1, maxPayoutUsd: 2, game: "coin", interactionMode: "automatic", rule: { kind: "coin_side", side: "heads" } };
    const argumentsValue = { kind: "coin", wager };
    const disabled = { ...base, payments: { ...base.payments, userWalletsEnabled: false } };
    const enabled = { ...base, payments: { ...base.payments, userWalletsEnabled: true } };
    expect(validateToolCallArguments({
      name: "drawRandom",
      argumentsText: JSON.stringify(argumentsValue),
      arguments: argumentsValue,
      config: disabled,
    }).ok).toBe(false);
    expect(validateToolCallArguments({
      name: "drawRandom",
      argumentsText: JSON.stringify(argumentsValue),
      arguments: argumentsValue,
      config: enabled,
    }).ok).toBe(true);
  });

  it("returns a contract-owned valid example after structured argument errors", () => {
    const response = invalidToolCallResponse({
      name: "setMyTimezone",
      argumentsText: JSON.stringify({ action: "clear" }),
      arguments: { action: "clear" },
      config: loadConfig(),
    });

    expect(response).toEqual(expect.objectContaining({
      status: "error",
      errorCode: "invalid_tool_arguments",
      retryable: true,
      content: expect.stringContaining("Canonical valid example"),
    }));
    expect(response?.content).toContain('{"action":"set","timezone":"America/New_York"}');
  });
});
