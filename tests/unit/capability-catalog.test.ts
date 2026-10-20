import { describe, expect, it } from "vitest";
import { defineCapability, installedCapabilities, installedToolContracts, installedToolHandlers } from "../../src/capabilities/catalog.js";
import { TOOL_NAMES } from "../../src/tools/toolDefinition.js";
import { availableSandboxModes, missingSandboxModeConfig, sandboxModeAllowsRequester } from "../../src/capabilities/codeUpdates.js";
import type { SandboxModeRollout } from "../../src/execution/sandboxProfiles.js";
import type { AppConfig } from "../../src/config/env.js";

describe("installed capability catalog", () => {
  it("provides one validated declaration template for capability authors", () => {
    expect(() => defineCapability({ id: "foundation", summary: "", toolNames: [] })).toThrow(/must have a summary/i);
    expect(() => defineCapability({
      id: "foundation",
      summary: "Example capability.",
      toolNames: ["loadSkillContext", "loadSkillContext"],
    })).toThrow(/duplicate tools/i);
    const declaration = defineCapability({
      id: "foundation",
      summary: "Example capability.",
      toolNames: ["loadSkillContext"],
    });
    expect(Object.isFrozen(declaration)).toBe(true);
    expect(Object.isFrozen(declaration.toolNames)).toBe(true);
  });

  it("owns every model-facing tool exactly once with its handler", () => {
    const names = installedCapabilities.flatMap((capability) => capability.tools.map((tool) => tool.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => TOOL_NAMES.includes(name))).toBe(true);
    expect(installedToolContracts.map((tool) => tool.name)).toEqual(names);
    for (const name of names) expect(installedToolHandlers[name]).toBeTypeOf("function");
  });

  it("keeps ownership visible by capability instead of reconstructing it in registries", () => {
    for (const capability of installedCapabilities) {
      expect(capability.summary.length).toBeGreaterThan(20);
    }
    expect(installedCapabilities.find((capability) => capability.id === "randomGames")?.prepareTurn).toBeTypeOf("function");
    expect(installedCapabilities.map((capability) => capability.id)).not.toEqual(
      expect.arrayContaining(["reminders", "operations", "improvements", "spotify"]),
    );
    expect(installedToolContracts.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      "composeDiscordResponse", "undoConversationTurns", "createDiscordEmoji", "updateBotAvatar",
      "adminTransferWalletFunds", "adminSetWalletStarterAmount", "reconcileWalletTransfers",
    ]));
  });

  it("keeps every sandbox mode dormant until its product switch and credentials exist", () => {
    const sandbox = installedCapabilities.find((capability) => capability.id === "sandboxTasks");
    expect(sandbox?.tools.map((tool) => tool.name)).toContain("runSandboxAgent");
    const dormant = sandboxConfig({ code_change: "off", diagnosis: "off", computer: "off" }, { github: true });
    expect(availableSandboxModes(dormant)).toEqual([]);
    expect(sandbox?.tools.every((tool) => tool.available?.(dormant) === false)).toBe(true);

    const computerOnly = sandboxConfig({ code_change: "everyone", diagnosis: "off", computer: "everyone" }, { github: false });
    expect(availableSandboxModes(computerOnly)).toEqual(["computer"]);
    expect(missingSandboxModeConfig(computerOnly, "code_change")).toEqual([expect.stringContaining("GITHUB_TOKEN")]);
    expect(sandbox?.tools.every((tool) => tool.available?.(computerOnly) !== false)).toBe(true);
  });

  it("opens an operators-stage mode only to the bot owner and ops allowlist", () => {
    const staged = {
      ...sandboxConfig({ code_change: "off", diagnosis: "off", computer: "operators" }, { github: false }),
      allowlists: { ownerUserId: "owner", opsUserIds: ["ops"] },
    } as unknown as AppConfig;
    expect(availableSandboxModes(staged)).toEqual(["computer"]);
    expect(sandboxModeAllowsRequester(staged, "computer", "owner")).toBe(true);
    expect(sandboxModeAllowsRequester(staged, "computer", "ops")).toBe(true);
    expect(sandboxModeAllowsRequester(staged, "computer", "member")).toBe(false);
    expect(sandboxModeAllowsRequester(staged, "code_change", "owner")).toBe(false);
  });
});

function sandboxConfig(modes: Record<"code_change" | "diagnosis" | "computer", SandboxModeRollout>, input: { github: boolean }) {
  return {
    github: { token: input.github ? "ghp_test" : undefined },
    execution: { taskSigningSecret: "secret", sandbox: { modes } },
  } as unknown as AppConfig;
}
