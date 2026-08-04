import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBugReportResult, validatedBugReportTriage } from "../../src/execution/bugReportResult.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("readBugReportResult", () => {
  it("requires a machine-checkable regression before triage can authorize repair", () => {
    expect(validatedBugReportTriage({
      disposition: "confirmed_unfixed",
      summary: "seems broken",
      regression: null,
    })).toEqual(expect.objectContaining({
      disposition: "insufficient_evidence",
      regression: null,
    }));
  });

  it("preserves a confirmed defect with a regression contract", () => {
    const result = {
      disposition: "confirmed_unfixed" as const,
      summary: "The reply used stale state.",
      regression: {
        failureMode: "missing_evidence",
        expectedBehavior: "Use current durable state.",
        expectedTools: ["getDeploymentStatus"],
        forbiddenTools: [],
        mustContain: [],
        mustNotContain: [],
      }
    };
    expect(validatedBugReportTriage(result)).toBe(result);
  });

  it("retains a bounded machine-checkable private regression contract", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bug-result-"));
    paths.push(directory);
    const file = path.join(directory, "result.json");
    await fs.writeFile(file, JSON.stringify({
      disposition: "confirmed_fixed",
      summary: "Fixed the general evidence selection defect.",
      regression: {
        failureMode: "wrong_tool",
        expectedBehavior: "Use current evidence.",
        expectedTools: ["web__run", "web__run"],
        forbiddenTools: [],
        mustContain: ["source"],
        mustNotContain: [],
      },
    }));

    await expect(readBugReportResult(file)).resolves.toEqual({
      disposition: "confirmed_fixed",
      summary: "Fixed the general evidence selection defect.",
      regression: {
        failureMode: "wrong_tool",
        expectedBehavior: "Use current evidence.",
        expectedTools: ["web__run"],
        forbiddenTools: [],
        mustContain: ["source"],
        mustNotContain: [],
      },
    });
  });

  it("omits a regression contract without an observable assertion", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bug-result-"));
    paths.push(directory);
    const file = path.join(directory, "result.json");
    await fs.writeFile(file, JSON.stringify({
      disposition: "not_reproducible",
      summary: "No reproducible defect.",
      regression: { failureMode: "other", expectedBehavior: "Be better." },
    }));
    await expect(readBugReportResult(file)).resolves.toMatchObject({ regression: null });
  });

  it("rejects unknown tool assertions before they can authorize repair", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bug-result-"));
    paths.push(directory);
    const file = path.join(directory, "result.json");
    await fs.writeFile(file, JSON.stringify({
      disposition: "confirmed_unfixed",
      summary: "The reply used the wrong tool.",
      regression: {
        failureMode: "wrong_tool",
        expectedBehavior: "Use a supported retrieval tool.",
        expectedTools: ["inventedTool"],
      },
    }));
    const parsed = await readBugReportResult(file);
    expect(parsed?.regression).toBeNull();
    expect(validatedBugReportTriage(parsed).disposition).toBe("insufficient_evidence");
  });
});
