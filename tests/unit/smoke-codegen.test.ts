import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatSmokeSummary, parseArgs } from "../../scripts/smokeCodegen.js";

describe("codegen smoke script helpers", () => {
  it("loads long smoke requests from a file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegen-smoke-request-"));
    try {
      const requestPath = path.join(tempDir, "request.txt");
      await fs.writeFile(requestPath, "Make the codegen task update a fixture file.\n", "utf8");

      const args = await parseArgs(["--harness", "opencode", "--model", "z-ai/glm-5.2", "--request-file", requestPath]);

      expect(args.request).toBe("Make the codegen task update a fixture file.\n");
      expect(args.requestFile).toBe(requestPath);
      expect(args.harness).toBe("opencode");
      expect(args.model).toBe("z-ai/glm-5.2");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("summarizes terminal failures with diagnosis metadata", () => {
    const summary = formatSmokeSummary({
      taskId: "task-local-opencode-1",
      harness: "opencode",
      model: "z-ai/glm-5.2",
      title: "Local smoke",
      request: "Make a tiny change.",
      workDir: "/tmp/work",
      artifactDir: "/tmp/work/artifacts",
      durationMs: 2500,
      exit: { code: 1, signal: null },
      callbacks: [
        {
          at: "2026-07-03T06:00:00.000Z",
          path: "/internal/tasks/task-local-opencode-1/events",
          body: { step: "opencode_attempt_1", message: "Starting OpenCode server attempt 1/1." }
        },
        {
          at: "2026-07-03T06:00:02.000Z",
          path: "/internal/tasks/task-local-opencode-1/complete",
          body: { status: "no_changes", error: "Agent task produced no diff." }
        }
      ],
      completion: {
        status: "no_changes",
        error: "Agent task produced no diff.",
        metadata: {
          failureDiagnosis: {
            category: "no_diff",
            summary: "OpenCode finished but left the repository with no code diff.",
            nextAction: "Inspect the harness transcript and request context.",
            failedPhase: "opencode",
            slowestPhase: { name: "opencode", durationMs: 2000 }
          }
        }
      }
    });

    expect(summary).toContain("Status: no_changes");
    expect(summary).toContain("Duration: 2.5s");
    expect(summary).toContain("## Failure Diagnosis");
    expect(summary).toContain("- category: no_diff");
    expect(summary).toContain("- nextAction: Inspect the harness transcript and request context.");
    expect(summary).toContain("- slowestPhase: opencode (2.0s)");
    expect(summary).toContain("Starting OpenCode server attempt 1/1.");
  });
});
