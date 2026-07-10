import { describe, expect, it } from "vitest";
import { isLeakedHostedToolMarkup, stripLeakedHostedToolMarkup } from "../../src/agent/modelRecovery.js";

describe("isLeakedHostedToolMarkup", () => {
  it("detects the exact markup leaked in prod with a mutated tool name", () => {
    // A prod incident posted this string verbatim to Discord.
    expect(isLeakedHostedToolMarkup("<tool_call>openserver_web_search</tool_call>")).toBe(true);
  });

  it("detects canonical hosted tool markup", () => {
    expect(
      isLeakedHostedToolMarkup(
        "<tool_call>openrouter_web_search<arg_key>query</arg_key><arg_value>weather</arg_value></tool_call>"
      )
    ).toBe(true);
  });

  it("detects tool_call markup with any unknown tool name", () => {
    expect(isLeakedHostedToolMarkup("<tool_call>made_up_tool_name</tool_call>")).toBe(true);
  });

  it("detects unterminated tool_call markup", () => {
    expect(isLeakedHostedToolMarkup("<tool_call>openrouter_web_fetch<arg_key>url</arg_key>")).toBe(true);
  });

  it("detects bare mutated hosted tool names without tags", () => {
    expect(isLeakedHostedToolMarkup("openserver_web_search query stuff")).toBe(true);
    expect(isLeakedHostedToolMarkup("openrouter_datetime")).toBe(true);
  });

  it("detects arg markup without a tool_call wrapper", () => {
    expect(isLeakedHostedToolMarkup("<arg_key>query</arg_key><arg_value>weather</arg_value>")).toBe(true);
  });

  it("does not flag ordinary answers", () => {
    expect(isLeakedHostedToolMarkup("The weather in SF is 62F and sunny.")).toBe(false);
    expect(isLeakedHostedToolMarkup("You can search the web for that.")).toBe(false);
    expect(isLeakedHostedToolMarkup("")).toBe(false);
  });
});

describe("stripLeakedHostedToolMarkup", () => {
  it("strips the exact prod leak to an empty string so recovery triggers", () => {
    expect(stripLeakedHostedToolMarkup("<tool_call>openserver_web_search</tool_call>")).toBe("");
  });

  it("strips tool_call blocks regardless of the tool name inside", () => {
    expect(
      stripLeakedHostedToolMarkup(
        "<tool_call>whatever_name<arg_key>q</arg_key><arg_value>x</arg_value></tool_call>"
      )
    ).toBe("");
  });

  it("strips unterminated tool_call blocks to the end of the content", () => {
    expect(stripLeakedHostedToolMarkup("<tool_call>openrouter_web_search<arg_key>query</arg_key>")).toBe("");
  });

  it("keeps surrounding prose while removing embedded markup", () => {
    const stripped = stripLeakedHostedToolMarkup(
      "Here is what I found.\n<tool_call>openserver_web_search</tool_call>\nLet me know if you want more."
    );
    expect(stripped).toContain("Here is what I found.");
    expect(stripped).toContain("Let me know if you want more.");
    expect(stripped).not.toContain("tool_call");
    expect(stripped).not.toContain("openserver_web_search");
  });

  it("strips stray arg markup and orphan closing tags", () => {
    expect(stripLeakedHostedToolMarkup("<arg_key>query</arg_key><arg_value>weather</arg_value>")).toBe("");
    expect(stripLeakedHostedToolMarkup("answer</tool_call>")).toBe("answer");
  });

  it("strips bare mutated hosted tool names at the start of the content", () => {
    expect(stripLeakedHostedToolMarkup("openserver_web_search query: latest scores")).toBe("");
  });

  it("leaves ordinary answers untouched", () => {
    expect(stripLeakedHostedToolMarkup("The weather in SF is 62F and sunny.")).toBe(
      "The weather in SF is 62F and sunny."
    );
  });
});
