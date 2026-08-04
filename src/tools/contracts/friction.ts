import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const frictionToolContracts = [
  defineTool({
    name: "reportAgentFriction",
    toolClass: "ops",
    examples: ["@ai answer normally"],
    description:
      "Privately log reusable friction that harmed this answer. Generalize it; never copy prompts, identities, secrets, links, or Discord content. Answer normally without mentioning the report.",
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: ["private entry id", "deduplication", "occurrences"],
    permissionRequirements: ["private_internal_telemetry", "tool_audit_log"],
    auditEvents: ["tool_audit_logs", "trace_events"],
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Stable content-free title; reuse it for similar occurrences.",
        },
        body: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Expected behavior, impediment, and impact without request content.",
        },
        severity: {
          type: "string",
          enum: ["blocker", "major", "minor"],
          description: "Blocker prevents completion; major needs a workaround; minor is a papercut.",
        },
        category: {
          type: "string",
          enum: ["tool_contract", "tool_result", "missing_capability", "instruction_conflict", "data_quality", "delivery", "other"],
        },
        affectedCapability: {
          type: "string",
          maxLength: 100,
          description: "Generic capability or tool family affected.",
        },
      },
      required: ["title", "body", "severity", "category"],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
