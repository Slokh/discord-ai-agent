import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const externalResearchToolContracts = [
  defineTool({
    name: "web__run",
    examples: [
      "@ai find the latest official release notes for this library",
      "@ai read https://example.com and summarize the relevant section",
    ],
    description:
      "Research current or external public information with hosted web search and page fetching. Use this for changing facts, unfamiliar topics, source-backed answers, or public URLs. Submit one or more concrete web operations; the result returns grounded findings and source URLs when available.",
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["research question", "current grounded findings", "source URLs when available", "explicit provider limitation on failure"],
    parameters: {
      type: "object",
      properties: {
        search_query: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              q: { type: "string", minLength: 1, pattern: "\\S" },
              recency: { type: "number", minimum: 1 },
              domains: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 10 },
            },
            required: ["q"],
            additionalProperties: false,
          },
          description: "Public web searches to run.",
        },
        open: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref_id: { type: "string", minLength: 1 },
              lineno: { type: "number", minimum: 0 },
            },
            required: ["ref_id"],
            additionalProperties: false,
          },
          maxItems: 8,
          description: "Public URLs or prior search result references to open.",
        },
        time: {
          type: "array",
          items: {
            type: "object",
            properties: { utc_offset: { type: "string", pattern: "^[+-](?:0\\d|1\\d|2[0-3]):[0-5]\\d$" } },
            required: ["utc_offset"],
            additionalProperties: false,
          },
          maxItems: 8,
          description: "UTC offsets whose current date and time should be retrieved.",
        },
        response_length: {
          type: "string",
          enum: ["short", "medium", "long"],
          description: "Requested research-result detail. Defaults to short.",
        },
      },
      anyOf: [
        { required: ["search_query"] },
        { required: ["open"] },
        { required: ["time"] },
      ],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
