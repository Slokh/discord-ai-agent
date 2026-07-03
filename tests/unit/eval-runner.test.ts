import { describe, expect, it } from "vitest";
import { buildPromptCommand, evaluatePromptAssertions, evidenceFromTrace, extractPromptJson, filterPrompts, parseEvalArgs, type EvalPrompt } from "../../scripts/eval.js";

const basePrompt: EvalPrompt = {
  id: "history-job",
  category: "history",
  prompt: "what did people say about jobs?",
  notes: undefined,
  expectedTools: [],
  expectedRequestedTools: [],
  mustContain: [],
  mustNotContain: [],
  promptArgs: [],
  noMemory: true,
  useDiscordMemory: false,
  skip: false
};

describe("eval runner", () => {
  it("parses eval CLI options", () => {
    expect(parseEvalArgs(["--file", "evals/prompts/core.json", "--include-private", "--category=history", "--filter", "job", "--json"])).toEqual(
      expect.objectContaining({
        files: ["evals/prompts/core.json"],
        includePrivate: true,
        category: "history",
        filter: "job",
        json: true
      })
    );
  });

  it("filters prompts by category and text", () => {
    const prompts = [
      { ...basePrompt, id: "history-job", category: "history", prompt: "job hunting" },
      { ...basePrompt, id: "stats-channels", category: "stats", prompt: "rank channels" }
    ];

    expect(filterPrompts(prompts, { category: "history", filter: "job" }).map((prompt) => prompt.id)).toEqual(["history-job"]);
  });

  it("builds prompt commands through the real prompt CLI path", () => {
    expect(
      buildPromptCommand({
        ...basePrompt,
        promptArgs: ["--channel=general"],
        prompt: "what happened recently?"
      })
    ).toEqual({
      command: "npm",
      args: ["run", "prompt", "--", "--json", "--no-memory", "--channel=general", "what happened recently?"]
    });
  });

  it("extracts prompt JSON even when surrounding output exists", () => {
    expect(extractPromptJson('noise\n{"runId":"local-1","content":"hello","durationMs":42}\n').content).toBe("hello");
  });

  it("derives selected and requested tools from trace metadata", () => {
    expect(
      evidenceFromTrace(
        [
          {
            metadata: {
              requestedToolCalls: ["findDiscordUsers", "summarizeDiscordHistory"],
              requestedToolRequests: [{ name: "openrouter:web_search" }],
              selectedLocalTools: ["findDiscordUsers"],
              selectedLocalToolRequests: [{ name: "summarizeDiscordHistory" }]
            }
          }
        ],
        [{ toolName: "findDiscordUsers" }, { toolName: "summarizeDiscordHistory" }]
      )
    ).toEqual({
      requestedTools: ["findDiscordUsers", "summarizeDiscordHistory", "openrouter:web_search"],
      selectedTools: ["findDiscordUsers", "summarizeDiscordHistory"],
      auditedTools: ["findDiscordUsers", "summarizeDiscordHistory"],
      traceEventCount: 1,
      toolAuditCount: 2
    });
  });

  it("evaluates deterministic assertions", () => {
    expect(
      evaluatePromptAssertions(
        {
          ...basePrompt,
          expectedTools: ["searchDiscordHistory"],
          expectedRequestedTools: ["openrouter:web_search"],
          mustContain: ["job"],
          mustNotContain: ["Sources:"],
          maxLatencyMs: 100
        },
        {
          answer: "People talked about job interviews.",
          durationMs: 50,
          evidence: {
            requestedTools: ["searchDiscordHistory", "openrouter:web_search"],
            selectedTools: ["searchDiscordHistory"],
            auditedTools: [],
            traceEventCount: 1,
            toolAuditCount: 0
          }
        }
      )
    ).toEqual([]);

    expect(
      evaluatePromptAssertions(
        {
          ...basePrompt,
          expectedTools: ["getDiscordStats"],
          expectedRequestedTools: ["openrouter:web_search"],
          mustContain: ["ranked"],
          mustNotContain: ["Sources:"],
          maxLatencyMs: 10
        },
        {
          answer: "Sources: none",
          durationMs: 20,
          evidence: {
            requestedTools: [],
            selectedTools: ["searchDiscordHistory"],
            auditedTools: [],
            traceEventCount: 1,
            toolAuditCount: 0
          }
        }
      )
    ).toEqual([
      "expected tool getDiscordStats was not observed",
      "expected requested tool openrouter:web_search was not observed",
      "answer did not contain required text: ranked",
      "answer contained forbidden text: Sources:",
      "latency 20ms exceeded 10ms"
    ]);
  });
});
