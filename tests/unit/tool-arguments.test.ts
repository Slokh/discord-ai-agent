import { describe, expect, it } from "vitest";
import { parseToolArguments } from "../../src/agent/toolArguments.js";

describe("tool argument parsing", () => {
  it("recovers only trailing unclosed JSON containers", () => {
    expect(parseToolArguments('{"inspectionId":"mppi_1","query":{"stops":"1"}')).toEqual({
      inspectionId: "mppi_1",
      query: { stops: "1" },
    });
    expect(parseToolArguments('{"items":[{"id":1}')).toEqual({
      items: [{ id: 1 }],
    });
  });

  it("rejects malformed content that is not a trailing delimiter omission", () => {
    expect(parseToolArguments('{"effect":"read_only", nope}')).toEqual({});
    expect(parseToolArguments('{"effect":"read_only"}}')).toEqual({});
    expect(parseToolArguments('{"effect":"read_only')).toEqual({});
  });
});
