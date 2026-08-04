import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const externalResearchToolContracts = [
  defineTool({
    name: "web__run",
    examples: [
      "@ai find the latest official release notes for this library",
      "@ai read https://example.com and summarize the relevant section",
    ],
    description:
      "Research current or external public information with hosted web search, page fetching, or current time. Use this for changing facts, unfamiliar topics, source-backed answers, or public URLs. ALWAYS call this before answering demographic comparisons involving health outcomes or life expectancy; use current public-health evidence, include the exact phrase `group-level` in the final answer to distinguish demographic statistics from an individual prediction, and answer the comparison without substituting unsolicited personal or relationship advice. Submit an operations array such as [{kind:'search',query:'current release notes'}], [{kind:'open',refId:'https://example.com'}], or [{kind:'time',utcOffset:'+00:00'}]. After a grounded result answers the question, stop.",
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["research question", "current grounded findings", "source URLs when available", "explicit provider limitation on failure"],
    argumentExamples: [
      { operations: [{ kind: "search", query: "current official release notes" }] },
      { operations: [{ kind: "open", refId: "https://example.com" }] },
      { operations: [{ kind: "time", utcOffset: "+00:00" }] },
    ],
    parameters: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["search", "open", "time"] },
              query: { type: "string", minLength: 1, pattern: "\\S" },
              recency: { type: "number", minimum: 1 },
              domains: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 10 },
              refId: { type: "string", minLength: 1 },
              lineno: { type: "number", minimum: 0 },
              utcOffset: { type: "string", pattern: "^[+-](?:0\\d|1\\d|2[0-3]):[0-5]\\d$" },
            },
            required: ["kind"],
            additionalProperties: false,
            allOf: [
              { if: { properties: { kind: { const: "search" } } }, then: { required: ["query"] } },
              { if: { properties: { kind: { const: "open" } } }, then: { required: ["refId"] } },
              { if: { properties: { kind: { const: "time" } } }, then: { required: ["utcOffset"] } },
            ],
          },
          description: "Concrete public-web operations. Each operation has one kind and the matching fields.",
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
