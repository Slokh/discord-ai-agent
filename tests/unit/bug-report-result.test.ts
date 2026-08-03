import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBugReportResult } from "../../src/execution/bugReportResult.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("readBugReportResult", () => {
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
});
