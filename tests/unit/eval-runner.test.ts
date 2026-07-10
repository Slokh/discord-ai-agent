import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildPromptCommand,
  compareEvalReports,
  evaluatePromptAssertions,
  evidenceFromTrace,
  extractPromptJson,
  filterPrompts,
  formatEvalSummary,
  parseEvalArgs,
  type EvalPrompt,
  type EvalRunReport
} from "../../scripts/eval.js";

const basePrompt: EvalPrompt = {
  id: "history-job",
  category: "history",
  prompt: "what did people say about jobs?",
  notes: undefined,
  expectedTools: [],
  expectedRequestedTools: [],
  mustContain: [],
  mustNotContain: [],
  auditMustNotMatch: [],
  promptArgs: [],
  noMemory: true,
  useDiscordMemory: false,
  skip: false
};

describe("eval runner", () => {
  it("parses eval CLI options", () => {
    expect(parseEvalArgs(["--file", "evals/prompts/core.json", "--include-private", "--category=history", "--filter", "job", "--compare=.eval-runs/base", "--json"])).toEqual(
      expect.objectContaining({
        files: ["evals/prompts/core.json"],
        includePrivate: true,
        category: "history",
        filter: "job",
        comparePath: ".eval-runs/base",
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
        [
          { toolName: "findDiscordUsers" },
          { toolName: "summarizeDiscordHistory", argumentsSummary: '{"query":"jobs"}', resultSummary: "3 messages" }
        ]
      )
    ).toEqual({
      requestedTools: ["findDiscordUsers", "summarizeDiscordHistory", "openrouter:web_search"],
      selectedTools: ["findDiscordUsers", "summarizeDiscordHistory"],
      auditedTools: ["findDiscordUsers", "summarizeDiscordHistory"],
      toolAuditLines: ["findDiscordUsers", 'summarizeDiscordHistory {"query":"jobs"} 3 messages'],
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
            toolAuditLines: [],
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
            toolAuditLines: [],
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

  it("fails auditMustNotMatch when the blackjack deal pre-draws the dealer's hole card", async () => {
    const core = JSON.parse(await fs.readFile("evals/prompts/core.json", "utf8")) as {
      prompts: Array<{ id: string; auditMustNotMatch?: string[] }>;
    };
    const patterns = core.prompts.find((prompt) => prompt.id === "random-blackjack-deal")?.auditMustNotMatch ?? [];
    expect(patterns.length).toBeGreaterThan(0);
    const prompt = { ...basePrompt, auditMustNotMatch: patterns };
    const output = (toolAuditLines: string[]) => ({
      answer: "Your hand: K♣ 9♠ = 19. Dealer shows 10♥.",
      durationMs: 50,
      evidence: {
        requestedTools: [],
        selectedTools: ["drawRandom"],
        auditedTools: ["drawRandom"],
        toolAuditLines,
        traceEventCount: 1,
        toolAuditCount: toolAuditLines.length
      }
    });

    // Correct deal: player hand plus a single dealer upcard.
    expect(
      evaluatePromptAssertions(
        prompt,
        output([
          'drawRandom {"kind":"cards","count":2,"reason":"player hand"} session rng_a nonce 1: cards (player hand) → K♣ 9♠ · shoe cards 1–2 of 52',
          'drawRandom {"kind":"cards","count":1,"reason":"dealer upcard"} session rng_a nonce 1: cards (dealer upcard) → 10♥ · shoe cards 3–3 of 52'
        ])
      )
    ).toEqual([]);

    // Leaky deal: the dealer draw exposes the hole card in the audit/footer.
    const dealerLeak = evaluatePromptAssertions(
      prompt,
      output([
        'drawRandom {"kind":"cards","count":2,"reason":"dealer hand"} session rng_a nonce 1: cards (dealer hand) → 6♠ 10♥ · shoe cards 3–4 of 52'
      ])
    );
    expect(dealerLeak).toHaveLength(1);
    expect(dealerLeak[0]).toContain("tool audit matched forbidden pattern");

    // Leaky deal: one combined draw for player and dealer.
    expect(
      evaluatePromptAssertions(
        prompt,
        output([
          'drawRandom {"kind":"cards","count":4,"reason":"initial deal"} session rng_a nonce 1: cards (initial deal) → K♣ 9♠ 6♠ 10♥ · shoe cards 1–4 of 52'
        ])
      )
    ).toHaveLength(1);
  });

  it("formats actionable eval summaries with requested, local, and audited tool evidence", () => {
    const report: EvalRunReport = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      durationMs: 1234,
      totals: { passed: 0, failed: 1, error: 0, skipped: 0, total: 1 },
      results: [
        {
          id: "web-current-external-fact",
          category: "web",
          prompt: "what is the next world cup match?",
          status: "failed",
          durationMs: 456,
          runId: "run-1",
          traceId: "trace-1",
          answer: "I only found Discord history.",
          evidence: {
            requestedTools: ["searchDiscordHistory"],
            selectedTools: ["searchDiscordHistory"],
            auditedTools: ["searchDiscordHistory"],
            toolAuditLines: [],
            traceEventCount: 2,
            toolAuditCount: 1
          },
          failures: ["expected requested tool openrouter:web_search was not observed"]
        }
      ]
    };

    expect(formatEvalSummary(report, ".eval-runs/example/results.json")).toContain(
      "FAILED web-current-external-fact (web; 0.456s; requested: searchDiscordHistory; local: searchDiscordHistory; audited: searchDiscordHistory; run: run-1; trace: trace-1)"
    );
    expect(formatEvalSummary(report, ".eval-runs/example/results.json")).toContain(
      "expected requested tool openrouter:web_search was not observed"
    );
    expect(formatEvalSummary(report, ".eval-runs/example/results.json")).toContain("answer: I only found Discord history.");
  });

  it("compares eval reports and highlights regressions and improvements", () => {
    const baseline: EvalRunReport = {
      generatedAt: "2026-07-03T00:00:00.000Z",
      durationMs: 1000,
      totals: { passed: 1, failed: 1, error: 0, skipped: 0, total: 2 },
      results: [
        {
          id: "web-current-external-fact",
          category: "web",
          prompt: "what is the next world cup match?",
          status: "passed",
          durationMs: 500,
          runId: "before-web",
          traceId: "before-web",
          answer: "Used web.",
          evidence: {
            requestedTools: ["openrouter:web_search"],
            selectedTools: [],
            auditedTools: [],
            toolAuditLines: [],
            traceEventCount: 1,
            toolAuditCount: 0
          },
          failures: []
        },
        {
          id: "stats-channel-popularity-normalized",
          category: "stats",
          prompt: "rank the channels by messages per day",
          status: "failed",
          durationMs: 800,
          runId: "before-stats",
          traceId: "before-stats",
          answer: "Wrong tool.",
          evidence: {
            requestedTools: ["searchDiscordHistory"],
            selectedTools: ["searchDiscordHistory"],
            auditedTools: ["searchDiscordHistory"],
            toolAuditLines: [],
            traceEventCount: 1,
            toolAuditCount: 1
          },
          failures: ["expected tool getDiscordStats was not observed"]
        }
      ]
    };
    const current: EvalRunReport = {
      ...baseline,
      totals: { passed: 1, failed: 1, error: 0, skipped: 0, total: 2 },
      results: [
        {
          ...baseline.results[0],
          status: "failed",
          durationMs: 650,
          answer: "Only searched Discord.",
          evidence: {
            requestedTools: ["searchDiscordHistory"],
            selectedTools: ["searchDiscordHistory"],
            auditedTools: ["searchDiscordHistory"],
            toolAuditLines: [],
            traceEventCount: 1,
            toolAuditCount: 1
          },
          failures: ["expected requested tool openrouter:web_search was not observed"]
        },
        {
          ...baseline.results[1],
          status: "passed",
          durationMs: 700,
          answer: "Used stats.",
          evidence: {
            requestedTools: ["getDiscordStats"],
            selectedTools: ["getDiscordStats"],
            auditedTools: ["getDiscordStats"],
            toolAuditLines: [],
            traceEventCount: 1,
            toolAuditCount: 1
          },
          failures: []
        }
      ]
    };

    const comparison = compareEvalReports(baseline, current, ".eval-runs/base");
    expect(comparison.totals).toEqual({ improved: 1, regressed: 1, changed: 0, unchanged: 0, new: 0, removed: 0 });
    const summary = formatEvalSummary(current, ".eval-runs/current/results.json", comparison);
    expect(summary).toContain("Improved: 1, regressed: 1");
    expect(summary).toContain("REGRESSED web-current-external-fact: passed -> failed (+0.150s)");
    expect(summary).toContain("requested: openrouter:web_search -> searchDiscordHistory");
    expect(summary).toContain("IMPROVED stats-channel-popularity-normalized: failed -> passed (-0.100s)");
  });
});
