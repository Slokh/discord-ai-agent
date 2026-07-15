import { describe, expect, it } from "vitest";
import {
  cleanResponse,
  formatDiscordMarkdownTables,
} from "../../src/tools/responseFormatting.js";

describe("Discord response formatting", () => {
  it("converts Markdown tables into padded Discord code blocks", () => {
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
        "```text",
        "Spin  Reel 1  Reel 2  Reel 3  Result",
        "1     🍒      🍋      🔔      ❌ Loss",
        "2     ⭐      🍒      🍒      🍒🍒🍒 Break even",
        "13    🍀      🍀      🍀      85x — +$420!! 🎉",
        "```",
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
        "```text",
        "Name   Score",
        "Ada    10",
        "Grace  9",
        "```",
      ].join("\n"),
    );
  });

  it("supports a blank header for the row-label column", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "| | Cards | Total |",
          "| --- | --- | --- |",
          "| **You** | 2♣ 10♠ | **12** |",
          "| **Dealer** | K♣ ? | ? |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "```text",
        "        Cards   Total",
        "You     2♣ 10♠  12",
        "Dealer  K♣ ?    ?",
        "```",
      ].join("\n"),
    );
  });

  it("does not treat an all-empty header as a table", () => {
    const content = [
      "| | |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n");

    expect(formatDiscordMarkdownTables(content)).toBe(content);
  });

  it("converts multi-row two-column key/value tables with empty headers", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "**MPP Wallet Status** 💰",
          "",
          "| | |",
          "|---|---|",
          "| **Address** | `0x7D8B7aC6a16F9Ad5a647Dd4837c270b460b1A462` |",
          "| **Balance** | $0.97 |",
          "| **Health** | ⚠️ Low balance |",
          "| **Today's spend** | $0 / $10 |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "**MPP Wallet Status** 💰",
        "",
        "```text",
        "Address        0x7D8B7aC6a16F9Ad5a647Dd4837c270b460b1A462",
        "Balance        $0.97",
        "Health         ⚠️ Low balance",
        "Today's spend  $0 / $10",
        "```",
      ].join("\n"),
    );
  });

  it("converts multi-row headerless grids into padded code blocks", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "| | | |",
          "| --- | --- | --- |",
          "| TORNADO | CASTLE | LANTERN |",
          "| 🔵 TORNADO | ⬜ CASTLE | 🔴 LANTERN |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "```text",
        "TORNADO     CASTLE     LANTERN",
        "🔵 TORNADO  ⬜ CASTLE  🔴 LANTERN",
        "```",
      ].join("\n"),
    );
  });

  it("pads emoji graphemes and keeps Markdown control characters literal", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "| # | Reels | Result | Payout |",
          "| --- | --- | --- | --- |",
          "| 1 | 🍊🍋🍇 | — | -$5 |",
          "| 8 | 🍋🍒🍒 | **2x🍒** | +$0 |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "```text",
        "#  Reels   Result  Payout",
        "1  🍊🍋🍇  —       -$5",
        "8  🍋🍒🍒  2x🍒    +$0",
        "```",
      ].join("\n"),
    );
  });

  it("converts compact multi-column bullet tables into padded code blocks", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "10 spins at $5 each ($50 total wagered):",
          "",
          "**# · Reels · Result · Payout**",
          "- 1 · 🍋⭐🍊 · — · -$5",
          "- 2 · 🍒🍒🍒 · **TRIPLE 🍒 5x** · +$25 🎉",
          "- 10 · ⭐7️⃣7️⃣ · — · -$5",
          "",
          "**Net:** -$25",
        ].join("\n"),
      ),
    ).toBe(
      [
        "10 spins at $5 each ($50 total wagered):",
        "",
        "```text",
        "#   Reels   Result        Payout",
        "1   🍋⭐🍊  —             -$5",
        "2   🍒🍒🍒  TRIPLE 🍒 5x  +$25 🎉",
        "10  ⭐7️⃣7️⃣  —             -$5",
        "```",
        "",
        "**Net:** -$25",
      ].join("\n"),
    );
  });

  it("leaves ordinary middle-dot bullet lists alone", () => {
    const content = [
      "**Choices · Notes · Owner**",
      "- only one structured row · so this is · still prose",
      "- ordinary bullet without columns",
    ].join("\n");

    expect(formatDiscordMarkdownTables(content)).toBe(content);
  });

  it("falls back to labeled bullets when a table is too wide for Discord", () => {
    const wideValue = "x".repeat(80);

    expect(
      formatDiscordMarkdownTables(
        [
          "| Name | Detail |",
          "| --- | --- |",
          `| Ada | ${wideValue} |`,
        ].join("\n"),
      ),
    ).toBe(
      [
        "**Columns:** Name · Detail",
        `- Ada · ${wideValue}`,
      ].join("\n"),
    );
  });

  it("keeps rendered links in the bullet fallback", () => {
    expect(
      formatDiscordMarkdownTables(
        [
          "| Name | Source |",
          "| --- | --- |",
          "| Ada | [profile](https://example.test/ada) |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "**Columns:** Name · Source",
        "- Ada · [profile](https://example.test/ada)",
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
      [
        "```text",
        "A    B",
        "one  two",
        "```",
      ].join("\n"),
    );
  });
});
