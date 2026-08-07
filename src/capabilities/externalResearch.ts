import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { ToolName } from "../tools/toolDefinition.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";

export const EXTERNAL_EVIDENCE_BLOCKED_RESPONSE =
  "The requested external information could not be verified, so I can't provide an answer based on it.";

/** Prevents a final answer from substituting recall for a failed evidence lookup. */
export class ExternalResearchCapability {
  private evidenceMissing = false;

  constructor(private readonly ctx: ToolContext) {}

  observeToolResult(toolName: ToolName, result: AgentResponse) {
    if (toolName === "web__run" && result.errorCode === "external_evidence_missing") {
      this.evidenceMissing = true;
    }
  }

  async finalizeResponse(response: AgentResponse): Promise<AgentResponse> {
    if (!this.evidenceMissing) return response;
    await recordAgentEvent(this.ctx, {
      eventName: "agent.external_research.evidence_blocked",
      level: "warn",
      summary: "Blocked a final answer after external research returned no usable evidence.",
      metadata: { errorCode: "external_evidence_missing" },
    }).catch(() => undefined);
    return {
      ...response,
      content: EXTERNAL_EVIDENCE_BLOCKED_RESPONSE,
      status: "error",
      errorCode: "external_evidence_missing",
      retryable: true,
      storedContent: undefined,
      files: undefined,
      tables: undefined,
      discordPresentation: undefined,
    };
  }
}
