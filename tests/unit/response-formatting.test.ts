import { describe, expect, it } from "vitest";
import {
  cleanResponse,
  formatDiscordMarkdownTables,
} from "../../src/tools/responseFormatting.js";

describe("Discord response formatting", () => {
  it("converts Markdown tables into compact Discord-readable lists", () => {
    const content = [
      "**20 spins at $5 each. Here we go:**",
      "",
      "| Spin | Reel 1 | Reel 2 | Reel 3 | Result |",
      "|------|--------|--------|--------|--------|",
      "| 1 | 🍒 | 🍋 | 🔔 | ❌ Loss |",
      "| 2 | ⭐ | 🍒 | 🍒 | 🍒🍒🍒 Break even |",
      "| 13 | 🍀 | 🍀 | 🍀 | **85x — +$420!!** 🎉 |",
      "",
      "**Summary:**",
      "- Net: **+$380**",
    ].join("\n");

    expect(formatDiscordMarkdownTables(content)).toBe(
      [
        "**20 spins at $5 each. Here we go:**",
        "",
        "**Spin · Reel 1 · Reel 2 · Reel 3 · Result**",
        "- 1 · 🍒 · 🍋 · 🔔 · ❌ Loss",
        "- 2 · ⭐ · 🍒 · 🍒 · 🍒🍒🍒 Break even",
        "- 13 · 🍀 · 🍀 · 🍀 · **85x — +$420!!** 🎉",
        "",
        "**Summary:**",
        "- Net: **+$380**",
      ].join("\n"),
    );
  });

  it("supports alignment markers and tables without outer pipes", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "Name | Score",
          ":--- | ---:",
          "Ada | 10",
          "Grace | 9",
        ].join("\n"),
      ),
    ).toBe(
      [
        "**Name · Score**",
        "- Ada · 10",
        "- Grace · 9",
      ].join("\n"),
    );
  });

  it("does not rewrite ordinary pipe text or fenced code examples", () => {
    const content = [
      "Use `foo | bar` as written.",
      "",
      "```md",
      "| Name | Score |",
      "| --- | --- |",
      "| Ada | 10 |",
      "```",
    ].join("\n");

    expect(formatDiscordMarkdownTables(content)).toBe(content);
  });

  it("normalizes tables before enforcing the Discord character limit", () => {
    const content = [
      "| A | B |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n");

    expect(cleanResponse(content, 2_000)).toBe(
      "**A · B**\n- one · two",
    );
  });
});
