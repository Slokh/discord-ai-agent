import { describe, expect, it } from "vitest";
import { assertToolRegistryContractsValid, validateToolCallArguments } from "../../src/tools/toolContractValidation.js";
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
    expect(validateToolCallArguments({ name: "listTools", arguments: {}, argumentsText: "not-json" }).ok).toBe(false);
    expect(validateToolCallArguments({ name: "listTools", arguments: {}, argumentsText: "[]" }).ok).toBe(false);
  });

  it("validates against the same deployment-narrowed schema shown to the model", () => {
    const base = loadConfig();
    const config = { ...base, discord: { ...base.discord, premiumSkuIds: [] } };
    expect(validateToolCallArguments({
      name: "composeDiscordResponse",
      argumentsText: JSON.stringify({ components: [{ type: "action_row", components: [{ type: "button", style: "premium", skuId: "123456789012345678" }] }] }),
      arguments: { components: [{ type: "action_row", components: [{ type: "button", style: "premium", skuId: "123456789012345678" }] }] },
      config,
    }).ok).toBe(false);
  });
});
