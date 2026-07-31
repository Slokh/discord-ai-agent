import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSmokeSuiteSummary, formatSmokeSummary, loadSmokeSuite, parseArgs } from "../../scripts/smokeCodegen.js";

describe("codegen smoke script helpers", () => {
  it("defaults smoke runs to NanoCodex Sol", async () => {
    await expect(parseArgs([])).resolves.toEqual(
      expect.objectContaining({ model: "openai/gpt-5.6-sol" })
    );
  });

  it("loads long smoke requests from a file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegen-smoke-request-"));
    try {
      const requestPath = path.join(tempDir, "request.txt");
      await fs.writeFile(requestPath, "Make the codegen task update a fixture file.\n", "utf8");

      const args = await parseArgs(["--model", "openai/gpt-5.6-luna", "--request-file", requestPath]);

      expect(args.request).toBe("Make the codegen task update a fixture file.\n");
      expect(args.requestFile).toBe(requestPath);
      expect(args.model).toBe("openai/gpt-5.6-luna");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("parses codegen smoke suite files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegen-smoke-suite-"));
    try {
      const suitePath = path.join(tempDir, "suite.json");
      await fs.writeFile(
        suitePath,
        JSON.stringify({
          version: 1,
          name: "codegen-regressions",
          cases: [
            {
              id: "tool-schema",
              title: "Improve tool schema",
              request: "Make a small fixture edit.",
              model: "openai/gpt-5.6-luna",
              timeoutMs: 120000,
              closePr: true
            },
            {
              id: "expensive-case",
              request: "Skip this one.",
              skip: true,
              skipReason: "costly"
            }
          ]
        }),
        "utf8"
      );

      await expect(parseArgs(["--suite", suitePath, "--close-pr"])).resolves.toEqual(
        expect.objectContaining({
          suiteFile: suitePath,
          closePr: true
        })
      );
      await expect(loadSmokeSuite(suitePath)).resolves.toEqual({
        version: 1,
        name: "codegen-regressions",
        cases: [
          {
            id: "tool-schema",
            title: "Improve tool schema",
            request: "Make a small fixture edit.",
            requestFile: undefined,
            model: "openai/gpt-5.6-luna",
            timeoutMs: 120000,
            closePr: true,
            skip: undefined,
            skipReason: undefined
          },
          {
            id: "expensive-case",
            title: undefined,
            request: "Skip this one.",
            requestFile: undefined,
            model: undefined,
            timeoutMs: undefined,
            closePr: undefined,
            skip: true,
            skipReason: "costly"
          }
        ]
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizes codegen smoke suites", () => {
    const summary = formatSmokeSuiteSummary({
      suite: "codegen-regressions",
      suiteFile: "/tmp/suite.json",
      startedAt: "2026-07-03T06:00:00.000Z",
      durationMs: 12345,
      total: 2,
      passed: 1,
      failed: 1,
      skipped: 1,
      results: [
        {
          id: "readme",
          title: "README smoke",
          model: "openai/gpt-5.6-sol",
          status: "succeeded",
          durationMs: 4000,
          summaryPath: ".discord-ai-agent/codegen-smoke/readme/summary.md",
          prUrl: "https://github.com/example/discord-ai-agent/pull/1"
        },
        {
          id: "tool-schema",
          title: "Tool schema smoke",
          model: "openai/gpt-5.6-luna",
          status: "no_changes",
          durationMs: 8000,
          error: "Agent task produced no diff."
        },
        {
          id: "expensive",
          title: "Expensive smoke",
          model: "openai/gpt-5.6-sol",
          status: "skipped",
          durationMs: 0,
          skipped: true,
          skipReason: "costly"
        }
      ]
    });

    expect(summary).toContain("Suite: codegen-regressions");
    expect(summary).toContain("Passed: 1/2");
    expect(summary).toContain("Failed: 1");
    expect(summary).toContain("Skipped: 1");
    expect(summary).toContain("- tool-schema: no_changes (openai/gpt-5.6-luna, 8.0s)");
    expect(summary).toContain("Error: Agent task produced no diff.");
    expect(summary).toContain("Skip reason: costly");
  });

  it("summarizes terminal failures with diagnosis metadata", () => {
    const summary = formatSmokeSummary({
      taskId: "task-local-nanocodex-1",
      model: "openai/gpt-5.6-sol",
      title: "Local smoke",
      request: "Make a tiny change.",
      workDir: "/tmp/work",
      artifactDir: "/tmp/work/artifacts",
      durationMs: 2500,
      exit: { code: 1, signal: null },
      callbacks: [
        {
          at: "2026-07-03T06:00:00.000Z",
          path: "/internal/tasks/task-local-nanocodex-1/events",
          body: { step: "nanocodex_attempt_1", message: "Starting NanoCodex attempt 1/1." }
        },
        {
          at: "2026-07-03T06:00:02.000Z",
          path: "/internal/tasks/task-local-nanocodex-1/complete",
          body: { status: "no_changes", error: "Agent task produced no diff." }
        }
      ],
      completion: {
        status: "no_changes",
        error: "Agent task produced no diff.",
        metadata: {
          failureDiagnosis: {
            category: "no_diff",
            summary: "NanoCodex finished but left the repository with no code diff.",
            nextAction: "Inspect the harness transcript and request context.",
            failedPhase: "nanocodex",
            slowestPhase: { name: "nanocodex", durationMs: 2000 }
          }
        }
      }
    });

    expect(summary).toContain("Status: no_changes");
    expect(summary).toContain("Duration: 2.5s");
    expect(summary).toContain("## Failure Diagnosis");
    expect(summary).toContain("- category: no_diff");
    expect(summary).toContain("- nextAction: Inspect the harness transcript and request context.");
    expect(summary).toContain("- slowestPhase: nanocodex (2.0s)");
    expect(summary).toContain("Starting NanoCodex attempt 1/1.");
  });
});
