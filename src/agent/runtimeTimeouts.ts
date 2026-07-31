export class AgentRuntimeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRuntimeTimeoutError";
  }
}

export function isAgentRuntimeTimeoutError(error: unknown): error is AgentRuntimeTimeoutError {
  return error instanceof AgentRuntimeTimeoutError;
}

export async function withAgentRuntimeTimeouts<T>(input: {
  promiseFactory: (noteProgress: () => void, abortSignal: AbortSignal) => Promise<T>;
  hardTimeoutMs: number;
  silenceTimeoutMs?: number;
  label: string;
}): Promise<T> {
  let hardTimeout: NodeJS.Timeout | undefined;
  let silenceTimeout: NodeJS.Timeout | undefined;
  let rejectTimeout: ((error: AgentRuntimeTimeoutError) => void) | undefined;
  const abortController = new AbortController();
  const rejectForTimeout = (error: AgentRuntimeTimeoutError) => {
    abortController.abort(error);
    rejectTimeout?.(error);
  };
  const resetSilenceTimeout = () => {
    if (!input.silenceTimeoutMs) return;
    if (silenceTimeout) clearTimeout(silenceTimeout);
    silenceTimeout = setTimeout(
      () => rejectForTimeout(new AgentRuntimeTimeoutError(`${input.label} was silent for ${input.silenceTimeoutMs}ms.`)),
      input.silenceTimeoutMs
    );
    silenceTimeout.unref?.();
  };
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
    hardTimeout = setTimeout(
      () => rejectForTimeout(new AgentRuntimeTimeoutError(`${input.label} timed out after ${input.hardTimeoutMs}ms.`)),
      input.hardTimeoutMs,
    );
    hardTimeout.unref?.();
    resetSilenceTimeout();
  });

  try {
    return await Promise.race([
      input.promiseFactory(resetSilenceTimeout, abortController.signal),
      timeoutPromise,
    ]);
  } finally {
    if (hardTimeout) clearTimeout(hardTimeout);
    if (silenceTimeout) clearTimeout(silenceTimeout);
  }
}
