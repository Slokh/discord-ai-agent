import { defineTool, type ToolRegistryEntry } from "../toolDefinition.js";

export const improvementToolContracts = [
  defineTool({
    name: "reportImprovementSignal",
    toolClass: "ops",
    examples: ["@ai answer normally"],
    description:
      "Privately record a reusable improvement signal when a product, tool, data, or developer-experience issue materially harmed the answer. Generalize it and never copy prompts, identities, secrets, links, or private Discord content. Continue the answer without mentioning telemetry.",
    mutates: false,
    group: "ops",
    category: "ops",
    outputContract: ["private case id", "whether the signal coalesced", "current case status"],
    permissionRequirements: ["private_internal_telemetry", "tool_audit_log"],
    auditEvents: ["tool_audit_logs", "agent_runtime_events", "improvement_case_events"],
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 300, description: "Stable, content-free summary." },
        details: { type: "string", minLength: 1, maxLength: 4000, description: "Expected behavior, impediment, and impact without request content." },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
        classification: {
          type: "string",
          enum: ["unknown", "defect", "product_gap", "data_quality", "developer_friction", "external_incident", "expected_behavior"],
        },
        owningDomain: { type: "string", maxLength: 100, description: "Generic owning capability or subsystem." },
        stableCode: { type: "string", maxLength: 200, description: "Optional stable error or invariant code; omit request-specific identifiers." },
      },
      required: ["summary", "details", "severity", "classification"],
      additionalProperties: false,
    },
  }),
] satisfies ToolRegistryEntry[];
