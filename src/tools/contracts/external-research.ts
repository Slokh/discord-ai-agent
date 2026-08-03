import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const externalResearchToolContracts = [
  defineTool({
    name: "researchWeb",
    examples: [
      "@ai find the latest official release notes for this library",
      "@ai read https://example.com and summarize the relevant section",
    ],
    description:
      "Research current or external public information with hosted web search and page fetching. Use this for changing facts, unfamiliar topics, source-backed answers, or public URLs. Give it the complete research question and any relevant URLs; it returns grounded findings and source URLs when available.",
    mutates: false,
    group: "external",
    category: "external",
    toolClass: "external",
    outputContract: ["research question", "current grounded findings", "source URLs when available", "explicit provider limitation on failure"],
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          minLength: 1,
          pattern: "\\S",
          description: "The complete public-web research question to answer.",
        },
        urls: {
          type: "array",
          items: { type: "string", minLength: 1, pattern: "^https?://" },
          maxItems: 8,
          description: "Optional public URLs that should be fetched or used as primary sources.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
