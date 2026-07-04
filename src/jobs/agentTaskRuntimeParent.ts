import type { AgentTaskJob } from "../execution/types.js";

export function agentTaskRuntimeParentMetadata(job: Pick<AgentTaskJob, "parentAgentSessionId" | "parentAgentExecutionId" | "parentAgentThreadKey">) {
  return removeUndefinedValues({
    parentAgentSessionId: job.parentAgentSessionId,
    parentAgentExecutionId: job.parentAgentExecutionId,
    parentAgentThreadKey: job.parentAgentThreadKey
  });
}

function removeUndefinedValues(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
