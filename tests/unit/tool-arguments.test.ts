import { describe, expect, it } from "vitest";
import { parseToolArguments } from "../../src/agent/toolArguments.js";
import { selectModelToolRoutes } from "../../src/agent/modelToolRoutes.js";

describe("tool argument parsing", () => {
  it("recovers only trailing unclosed JSON containers", () => {
    expect(parseToolArguments('{"requestId":"request_1","query":{"stops":"1"}')).toEqual({
      requestId: "request_1",
      query: { stops: "1" },
    });
    expect(parseToolArguments('{"items":[{"id":1}')).toEqual({
      items: [{ id: 1 }],
    });
    const [route] = selectModelToolRoutes([{
      id: "repaired",
      name: "findDiscordUsers",
      argumentsText: '{"query":"alice"',
    }]);
    expect(route).toEqual(expect.objectContaining({
      arguments: { query: "alice" },
      argumentsText: '{"query":"alice"}',
      argumentsNormalized: true,
    }));
  });

  it("rejects malformed content that is not a trailing delimiter omission", () => {
    expect(parseToolArguments('{"effect":"read_only", nope}')).toEqual({});
    expect(parseToolArguments('{"effect":"read_only"}}')).toEqual({});
    expect(parseToolArguments('{"effect":"read_only')).toEqual({});
  });

  it("generically unwraps JSON-encoded top-level fields when the tool schema requires structure", () => {
    const components = [{
      type: "action_row",
      components: [{
        type: "button",
        label: "Details",
        style: "primary",
        action: { type: "continue", prompt: "Show details" },
      }],
    }];
    const [route] = selectModelToolRoutes([{
      id: "presentation",
      name: "composeDiscordResponse",
      argumentsText: JSON.stringify({ components: JSON.stringify(components) }),
    }]);

    expect(route?.arguments).toEqual({ components });
    expect(JSON.parse(route?.argumentsText ?? "{}")).toEqual({ components });
    expect(route?.argumentsNormalized).toBe(true);
  });

  it("does not reinterpret scalar strings or translate domain protocols", () => {
    const [scalar] = selectModelToolRoutes([{
      id: "resolver",
      name: "findDiscordUsers",
      argumentsText: JSON.stringify({ query: "[\"alice\"]" }),
    }]);
    const [wireFormat] = selectModelToolRoutes([{
      id: "presentation",
      name: "composeDiscordResponse",
      argumentsText: JSON.stringify({ components: JSON.stringify([{ type: 1, components: [{ type: 2, style: 1, custom_id: "unsafe" }] }]) }),
    }]);

    expect(scalar?.arguments).toEqual({ query: "[\"alice\"]" });
    expect(scalar?.argumentsNormalized).toBeUndefined();
    expect(wireFormat?.arguments).toEqual({ components: [{ type: 1, components: [{ type: 2, style: 1, custom_id: "unsafe" }] }] });
  });
});
