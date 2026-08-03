export class OpenRouterContentFilterError extends Error {
  readonly status?: number;
  readonly model?: string;
  readonly finishReason?: string;

  constructor(input: {
    status?: number;
    model?: string;
    finishReason?: string;
    message?: string;
  }) {
    super(input.message ?? "OpenRouter response was blocked by a content filter.");
    this.name = "OpenRouterContentFilterError";
    this.status = input.status;
    this.model = input.model;
    this.finishReason = input.finishReason;
  }
}

export class OpenRouterHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(input: { status: number; message: string; code?: string }) {
    super(`OpenRouter request failed (${input.status}): ${input.message}`);
    this.name = "OpenRouterHttpError";
    this.status = input.status;
    this.code = input.code;
  }
}

export class OpenRouterTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly path: string;

  constructor(input: { timeoutMs: number; path: string; cause?: unknown }) {
    super(`OpenRouter request timed out after ${input.timeoutMs}ms (${input.path}).`, {
      cause: input.cause,
    });
    this.name = "OpenRouterTimeoutError";
    this.timeoutMs = input.timeoutMs;
    this.path = input.path;
  }
}

export function isOpenRouterTimeoutError(
  error: unknown,
): error is OpenRouterTimeoutError {
  return error instanceof OpenRouterTimeoutError;
}

export function isOpenRouterContentFilterError(
  error: unknown,
): error is OpenRouterContentFilterError {
  return error instanceof OpenRouterContentFilterError;
}

export function isOpenRouterHttpError(
  error: unknown,
): error is OpenRouterHttpError {
  return error instanceof OpenRouterHttpError;
}
