import { describe, expect, it } from "vitest";
import { commandPayloads } from "../../src/discord/commands.js";

describe("/ai command payload", () => {
  it("does not register any Discord slash commands", () => {
    expect(commandPayloads).toEqual([]);
  });
});
