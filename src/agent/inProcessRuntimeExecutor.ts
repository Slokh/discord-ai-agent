import type { AgentResponse, ToolContext } from "../tools/types.js";
import { handleAgentRequest } from "./router.js";

export async function executeInProcessAgentRuntime(input: {
  toolContext: ToolContext;
  text: string;
  timeoutMs: number;
}): Promise<AgentResponse> {
  return withTimeout(handleAgentRequest(input.toolContext, input.text), input.timeoutMs, "Discord AI Agent agent request");
}

export class AgentRuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeTimeoutError";
  }
}

export function isAgentRuntimeTimeoutError(error: unknown): error is AgentRuntimeTimeoutError {
  return error instanceof AgentRuntimeTimeoutError;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new AgentRuntimeTimeoutError(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    timeout.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
