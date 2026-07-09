import { describe, expect, it } from "vitest";

import { scanContent } from "../../scripts/scanRelease.js";

const ownerName = ["Slo", "kh"].join("");
const privateEmojiId = ["152129", "940721", "4084337"].join("");
const fixtureSnowflake = ["987654", "321987", "654321"].join("");
const repeatedSnowflake = "1".repeat(18);
const sequentialSnowflake = ["123456789012", "345678"].join("");

describe("release scanner", () => {
  it("reports each new private-data rule with rule ids", () => {
    const content = [
      `api key ${["sk", "ABCDEFGHIJKLMNOP"].join("-")}`,
      `slack ${["xoxb", "abcdefghijkl"].join("-")}`,
      `auth Bearer ${"A".repeat(24)}`,
      `owner ${ownerName}`,
      `guild ${fixtureSnowflake}`,
      `emoji ${privateEmojiId}`
    ].join("\n");

    const findings = scanContent("src/example.ts", content);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "generic-api-key", line: 1, file: "src/example.ts" }),
        expect.objectContaining({ ruleId: "slack-token", line: 2, file: "src/example.ts" }),
        expect.objectContaining({ ruleId: "bearer-token", line: 3, file: "src/example.ts" }),
        expect.objectContaining({ ruleId: "private-owner", line: 4, file: "src/example.ts" }),
        expect.objectContaining({ ruleId: "discord-snowflake", line: 5, file: "src/example.ts" }),
        expect.objectContaining({ ruleId: "private-emoji", line: 6, file: "src/example.ts" })
      ])
    );
    expect(findings.every((finding: { excerpt: string }) => finding.excerpt.includes("[REDACTED]"))).toBe(true);
  });

  it("does not report placeholder bearer tokens or placeholder snowflakes", () => {
    const content = [
      `placeholder ${repeatedSnowflake}`,
      `fixture ${sequentialSnowflake}`,
      `auth Bearer ${["test", "token", "example", "aaaaaaaaaaaa"].join("-")}`
    ].join("\n");

    expect(scanContent("docs/example.md", content)).toEqual([]);
  });

  it("reports accurate line numbers", () => {
    const findings = scanContent("README.md", ["safe", "still safe", `bad ${ownerName}`].join("\n"));

    expect(findings).toEqual([expect.objectContaining({ ruleId: "private-owner", line: 3 })]);
  });

  it("allows the canonical public repository URL but still flags bare owner mentions", () => {
    const repoUrl = `https://github.com/${ownerName}/discord-ai-agent`;
    const allowed = [
      `"url": "git+${repoUrl}.git"`,
      `Report at ${repoUrl}/security/advisories/new or contact @${ownerName}.`
    ].join("\n");

    expect(scanContent("package.json", allowed)).toEqual([]);

    const flagged = scanContent("docs/example.md", `maintained by @${ownerName}`);
    expect(flagged).toEqual([expect.objectContaining({ ruleId: "private-owner", line: 1 })]);
  });
});
