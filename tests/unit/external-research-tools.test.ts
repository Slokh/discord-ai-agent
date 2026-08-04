import { describe, expect, it, vi } from "vitest";
import { externalResearchToolHandlers } from "../../src/tools/handlers/external-research.js";
import type { ToolContext } from "../../src/tools/types.js";

function context(chat: ToolContext["openRouter"]["chat"]): ToolContext {
  return {
    config: {
      appRevision: "test-revision",
      openRouter: { utilityModel: "test/utility" },
    } as never,
    repo: {
      recordTraceEvent: vi.fn(async () => undefined),
      recordProcessRunSpan: vi.fn(async () => undefined),
      auditTool: vi.fn(async () => undefined),
    },
    openRouter: { chat },
    guildId: "guild",
    channelId: "channel",
    userId: "user",
    userDisplayName: "User",
    visibleChannelIds: [],
    requestId: "trace-1",
  } as unknown as ToolContext;
}

describe("web__run", () => {
  it("uses the configured OpenRouter hosted tools and returns cited evidence", async () => {
    let submitted: { messages?: unknown[] } | undefined;
    const chat = vi.fn(async (request: { messages?: unknown[] }) => {
      submitted = request;
      return ({
      content: "The current UTC date is August 3, 2026.",
      model: "test/utility",
      finishReason: "stop",
      serverToolUse: { web_search_requests: 1 },
      urlCitations: [{ url: "https://example.com/date", title: "Date" }],
      toolCalls: [],
      raw: {},
      });
    }) as unknown as ToolContext["openRouter"]["chat"];
    const result = await externalResearchToolHandlers.web__run!(
      context(chat),
      {
        id: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "search", query: "current UTC date" }] },
        argumentsText: "{}",
      },
      "What is the date?",
    );

    expect(result).toEqual({
      content: "The current UTC date is August 3, 2026.\n\nSources:\n- https://example.com/date",
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      model: "test/utility",
      tools: [{ type: "openrouter:web_search" }],
      toolChoice: "required",
      maxTokens: 1_200,
      reasoningEffort: "none",
      signal: undefined,
    }));
    expect(submitted?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.stringContaining("Authoritative web operations:") }),
    ]));
    expect(JSON.stringify(submitted?.messages)).not.toContain("What is the date?");
    expect(JSON.stringify(submitted?.messages)).toContain("do not answer, mention, or infer any other part of the outer request");
  });

  it("offers only the hosted capability requested by the operation", async () => {
    const chat = vi.fn(async () => ({
      content: "The current UTC date is August 3, 2026.",
      model: "test/utility",
      finishReason: "stop",
      serverToolUse: { datetime_requests: 1 },
      toolCalls: [],
      raw: {},
    }));

    const result = await externalResearchToolHandlers.web__run!(
      context(chat),
      {
        id: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "time", utcOffset: "+00:00" }] },
        argumentsText: "{}",
      },
      "What is the date?",
    );

    expect(result).toEqual({ content: "The current UTC date is August 3, 2026." });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      tools: [{ type: "openrouter:datetime" }],
      toolChoice: "required",
    }));
  });

  it("does not turn an ungrounded provider answer into fresh evidence", async () => {
    const result = await externalResearchToolHandlers.web__run!(
      context(vi.fn(async () => ({ content: "I think it is today.", model: "test/utility", toolCalls: [], raw: {} }))),
      {
        id: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "time", utcOffset: "+00:00" }] },
        argumentsText: "{}",
      },
      "What is the date?",
    );

    expect(result).toMatchObject({ status: "error", errorCode: "external_evidence_missing", retryable: true });
  });

  it("does not turn an empty hosted-tool completion into evidence", async () => {
    const result = await externalResearchToolHandlers.web__run!(
      context(vi.fn(async () => ({
        content: "",
        model: "test/utility",
        serverToolUse: { tool_calls_requested: 1, tool_calls_executed: 1 },
        toolCalls: [],
        raw: {},
      }))),
      {
        id: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "time", utcOffset: "+00:00" }] },
        argumentsText: "{}",
      },
      "What is the date?",
    );

    expect(result).toMatchObject({ status: "error", errorCode: "external_evidence_missing", retryable: true });
    expect(result.content).toContain("without a readable result");
  });

  it("maps provider failures into a stable tool result", async () => {
    const result = await externalResearchToolHandlers.web__run!(
      context(vi.fn(async () => { throw new Error("provider unavailable with private detail"); })),
      {
        id: "call-1",
        name: "web__run",
        arguments: { operations: [{ kind: "time", utcOffset: "+00:00" }] },
        argumentsText: "{}",
      },
      "What is the date?",
    );

    expect(result).toMatchObject({ status: "error", errorCode: "external_evidence_missing", retryable: true });
    expect(result.content).not.toContain("private detail");
  });
});
