import { describe, expect, it } from "vitest";
import { defineCapability, installedCapabilities, installedToolContracts, installedToolHandlers } from "../../src/capabilities/catalog.js";
import { TOOL_NAMES, TOOL_NAMES_BY_CAPABILITY } from "../../src/tools/toolDefinition.js";

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
    expect(names).toEqual(TOOL_NAMES);
    expect(new Set(names).size).toBe(names.length);
    expect(installedToolContracts.map((tool) => tool.name)).toEqual(names);
    expect(Object.keys(installedToolHandlers).sort()).toEqual([...names].sort());
  });

  it("keeps ownership visible by capability instead of reconstructing it in registries", () => {
    for (const capability of installedCapabilities) {
      expect(capability.summary.length).toBeGreaterThan(20);
      expect(capability.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES_BY_CAPABILITY[capability.id]);
    }
    expect(installedCapabilities.find((capability) => capability.id === "randomGames")?.prepareTurn).toBeTypeOf("function");
    expect(installedCapabilities.find((capability) => capability.id === "codeUpdates")?.tools.map((tool) => tool.name)).toContain("runCodingAgent");
  });
});
