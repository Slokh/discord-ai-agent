import type { PreparedAgentCapability } from "../agent/capabilityRuntime.js";
import type { ToolContext } from "../tools/types.js";

/** Adds due-time semantics without teaching the generic agent loop about schedules. */
export function prepareScheduledRequestCapability(ctx: ToolContext): PreparedAgentCapability {
  if (!ctx.readOnlyExecution) return {};
  return {
    promptContributions: [{
      section: "scheduled request",
      stability: "turn",
      content:
        "This is a due occurrence of a schedule the requester explicitly created earlier. Perform the requested work now using fresh tool evidence when facts can change. " +
        "This occurrence is strictly read-only: it cannot authorize payments, Discord mutations, settings changes, code work, new schedules, or any other mutation. " +
        "Return the useful result directly and briefly name any evidence limitation instead of inventing an answer.",
    }],
  };
}
