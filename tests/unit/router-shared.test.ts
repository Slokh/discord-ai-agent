import { describe, expect, it } from "vitest";
import { cleanFinalModelResponse } from "../../src/agent/routerShared.js";

describe("router shared response cleanup", () => {
  it("removes internal historical-memory labels from visible replies", () => {
    expect(cleanFinalModelResponse(
      "Yes. [Earlier Discord AI Agent reply; not authoritative for Discord facts] I used that name.",
    )).toBe("Yes. I used that name.");
    expect(cleanFinalModelResponse(
      "[Earlier searchDiscordHistory result omitted. Request the relevant memory tool.] No evidence found.",
    )).toBe("No evidence found.");
  });
});
