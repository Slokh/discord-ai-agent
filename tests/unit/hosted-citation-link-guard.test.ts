import { describe, expect, it } from "vitest";
import { appendMissingHostedCitationLink } from "../../src/agent/hostedCitationLinkGuard.js";

describe("hosted citation link guard", () => {
  it("adds a safe hosted citation when an answer promises a missing link", () => {
    expect(appendMissingHostedCitationLink(
      "I found it — here's the link.",
      {
        serverToolUse: { web_search_requests: 1 },
        urlCitations: [{ url: "https://example.com/result", title: "Result" }],
      },
      1800,
    )).toEqual({
      content: "I found it — here's the link.\n\nSource: <https://example.com/result>",
      appended: true,
      citationCount: 1,
    });
  });

  it("does not add sources to an answer that neither promises a link nor used hosted web tools", () => {
    expect(appendMissingHostedCitationLink(
      "The current result is available.",
      {
        serverToolUse: { web_search_requests: 1 },
        urlCitations: [{ url: "https://example.com/result" }],
      },
      1800,
    ).appended).toBe(false);
    expect(appendMissingHostedCitationLink(
      "Here is the source.",
      {
        urlCitations: [{ url: "https://example.com/result" }],
      },
      1800,
    ).appended).toBe(false);
  });

  it("keeps an existing public link and rejects credential-bearing citations", () => {
    expect(appendMissingHostedCitationLink(
      "Source: <https://example.com/already-present>",
      {
        serverToolUse: { web_fetch_requests: 1 },
        urlCitations: [{ url: "https://example.com/other" }],
      },
      1800,
    ).appended).toBe(false);
    expect(appendMissingHostedCitationLink(
      "Here is the link.",
      {
        serverToolUse: { web_search_requests: 1 },
        urlCitations: [{ url: "https://user:secret@example.com/private" }],
      },
      1800,
    ).appended).toBe(false);
  });
});
