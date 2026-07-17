import type { AppConfig } from "../config/env.js";
import { durationMs, logger } from "../util/logger.js";

export type ChatContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "1h" } }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type FunctionToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenRouterServerToolDefinition = {
  type: `openrouter:${string}`;
  parameters?: Record<string, unknown>;
};

export type ToolDefinition = FunctionToolDefinition | OpenRouterServerToolDefinition;
export type ToolChoice = "auto" | "required" | "none" | {
  type: "function";
  function: { name: string };
};

export type ChatResult = {
  content: string;
  model: string;
  raw: unknown;
  finishReason?: string;
  usage?: OpenRouterTokenUsage;
  estimatedCostUsd?: number;
  toolCalls: Array<{
    id: string;
    name: string;
    argumentsText: string;
  }>;
};

export type OpenRouterTokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export type ImageResult = {
  data: Array<{
    url?: string;
    b64_json?: string;
    media_type?: string;
    content_type?: string;
    revised_prompt?: string;
  }>;
  model: string;
  raw: unknown;
  estimatedCostUsd?: number;
};

export type ImageOptions = {
  model?: string;
  inputReferences?: ImageReference[];
  resolution?: string;
  aspectRatio?: string;
  quality?: "auto" | "low" | "medium" | "high";
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "auto" | "transparent" | "opaque";
  n?: number;
};

export type OpenRouterRetryPolicy = "cheap" | "expensive";

/**
 * "batch" (default) tolerates slow providers with a long timeout and transient retries.
 * "interactive" fails fast (short timeout, single attempt) so a degraded embedding
 * provider cannot stall a live agent turn; callers fall back to keyword-only search.
 */
export type EmbedRequestProfile = "batch" | "interactive";

export type ImageReference = {
  type: "image_url";
  image_url: { url: string };
};

const OPENROUTER_CHAT_TIMEOUT_MS = 45_000;
const OPENROUTER_EMBEDDING_TIMEOUT_MS = 20_000;
const OPENROUTER_INTERACTIVE_EMBEDDING_TIMEOUT_MS = 4_000;
const OPENROUTER_IMAGE_TIMEOUT_MS = 120_000;
const OPENROUTER_TRANSIENT_RETRY_DELAYS_MS = [500, 1_500];

export class OpenRouterClient {
  constructor(private readonly config: AppConfig["openRouter"]) {}

  async chat(input: {
    messages: ChatMessage[];
    model?: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    temperature?: number;
    maxTokens?: number;
    retryPolicy?: OpenRouterRetryPolicy;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    const startedAt = Date.now();
    const model = input.model ?? this.config.chatModel;
    const localToolCount = input.tools?.filter((tool) => tool.type === "function").length ?? 0;
    const hostedToolCount = input.tools?.filter((tool) => tool.type !== "function").length ?? 0;
    logger.info(
      {
        provider: "openrouter",
        operation: "chat",
        model,
        messageCount: input.messages.length,
        imageInputCount: countChatImageInputs(input.messages),
        localToolCount,
        hostedToolCount,
        maxTokens: input.maxTokens ?? 4096,
        temperature: input.temperature ?? 0.3
      },
      "OpenRouter chat request"
    );

    const json = await this.request(
      "/chat/completions",
      {
        model,
        messages: messagesForPromptCaching(model, input.messages),
        tools: input.tools,
        tool_choice: input.toolChoice,
        temperature: input.temperature ?? 0.3,
        max_tokens: input.maxTokens ?? 4096
      },
      OPENROUTER_CHAT_TIMEOUT_MS,
      { retryPolicy: input.retryPolicy, signal: input.signal }
    );

    const choice = json.choices?.[0];
    const finishReason = finishReasonFromChoice(choice);
    if (isContentFilterSignal(finishReason)) {
      throw new OpenRouterContentFilterError({
        model: String(json.model ?? model),
        finishReason,
        message: "OpenRouter response was blocked by the model/provider content filter."
      });
    }

    const message = choice?.message ?? {};
    const rawContent = typeof message.content === "string" ? message.content : "";
    const structuredToolCalls =
      message.tool_calls?.map((call: any) => ({
        id: String(call.id),
        name: String(call.function?.name ?? ""),
        argumentsText: String(call.function?.arguments ?? "{}")
      })) ?? [];
    const dsmlToolCalls = structuredToolCalls.length === 0 && input.tools?.length ? parseDsmlToolCalls(rawContent) : [];
    const toolCalls = structuredToolCalls.length > 0 ? structuredToolCalls : dsmlToolCalls;
    const content = rawContent.includes("DSML") ? stripDsmlToolCalls(rawContent).trim() : rawContent;

    const result: ChatResult = {
      content,
      model: String(json.model ?? model),
      raw: json,
      finishReason,
      usage: extractTokenUsage(json),
      estimatedCostUsd: extractEstimatedCostUsd(json),
      toolCalls
    };
    logger.info(
      {
        provider: "openrouter",
        operation: "chat",
        model: result.model,
        durationMs: durationMs(startedAt),
        finishReason: result.finishReason,
        usage: result.usage,
        outputChars: result.content.length,
        toolCalls: result.toolCalls.map((call) => call.name),
        estimatedCostUsd: result.estimatedCostUsd
      },
      "OpenRouter chat response"
    );
    return result;
  }

  async embed(
    texts: string[],
    model = this.config.embeddingModel,
    dimensions?: number,
    options: { profile?: EmbedRequestProfile } = {}
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const profile = options.profile ?? "batch";
    const interactive = profile === "interactive";
    const startedAt = Date.now();
    logger.debug(
      {
        provider: "openrouter",
        operation: "embed",
        model,
        profile,
        textCount: texts.length,
        dimensions
      },
      "OpenRouter embedding request"
    );
    const json = await this.request(
      "/embeddings",
      {
        model,
        input: texts,
        dimensions
      },
      interactive ? OPENROUTER_INTERACTIVE_EMBEDDING_TIMEOUT_MS : OPENROUTER_EMBEDDING_TIMEOUT_MS,
      interactive ? { maxAttempts: 1 } : {}
    );

    const data = Array.isArray(json.data) ? json.data : [];
    const embeddings = data
      .sort((a: any, b: any) => Number(a.index ?? 0) - Number(b.index ?? 0))
      .map((item: any) => {
        if (!Array.isArray(item.embedding)) {
          throw new Error("OpenRouter embedding response did not include embedding arrays.");
        }
        return item.embedding.map(Number);
      });
    logger.debug(
      {
        provider: "openrouter",
        operation: "embed",
        model,
        profile,
        durationMs: durationMs(startedAt),
        vectorCount: embeddings.length,
        dimensions: embeddings[0]?.length
      },
      "OpenRouter embedding response"
    );
    return embeddings;
  }

  async generateImage(prompt: string, options?: ImageOptions): Promise<ImageResult> {
    const model = options?.model ?? this.config.imageModel;
    const startedAt = Date.now();
    logger.info(
      {
        provider: "openrouter",
        operation: "image",
        model,
        promptChars: prompt.length,
        inputReferenceCount: options?.inputReferences?.length ?? 0,
        resolution: options?.resolution,
        aspectRatio: options?.aspectRatio,
        quality: options?.quality,
        outputFormat: options?.outputFormat
      },
      "OpenRouter image request"
    );
    const body: Record<string, unknown> = {
      model,
      prompt
    };

    if (options?.resolution) body.resolution = options.resolution;
    if (options?.inputReferences?.length) body.input_references = options.inputReferences;
    if (options?.aspectRatio) body.aspect_ratio = options.aspectRatio;
    if (options?.quality) body.quality = options.quality;
    if (options?.outputFormat) body.output_format = options.outputFormat;
    if (options?.background) body.background = options.background;
    if (options?.n != null) body.n = options.n;

    const json = await this.request("/images", body, OPENROUTER_IMAGE_TIMEOUT_MS, { retryPolicy: "expensive" });

    const result: ImageResult = {
      data: Array.isArray(json.data) ? json.data : [],
      model: String(json.model ?? model),
      raw: json,
      estimatedCostUsd: extractEstimatedCostUsd(json)
    };
    logger.info(
      {
        provider: "openrouter",
        operation: "image",
        model: result.model,
        durationMs: durationMs(startedAt),
        imageCount: result.data.length,
        inputReferenceCount: options?.inputReferences?.length ?? 0,
        estimatedCostUsd: result.estimatedCostUsd
      },
      "OpenRouter image response"
    );
    return result;
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    options: { retryPolicy?: OpenRouterRetryPolicy; maxAttempts?: number; signal?: AbortSignal } = {}
  ): Promise<any> {
    if (!this.config.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for this operation.");
    }

    const totalStartedAt = Date.now();
    const maxAttempts = options.maxAttempts ?? OPENROUTER_TRANSIENT_RETRY_DELAYS_MS.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      const abortController = new AbortController();
      let timedOut = false;
      const forwardAbort = () => abortController.abort(options.signal?.reason);
      if (options.signal?.aborted) forwardAbort();
      else options.signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
      timeout.unref?.();
      let response: Response;
      let text: string;
      try {
        response = await fetch(`${this.config.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": this.config.httpReferer,
            "X-Title": this.config.appTitle
          },
          body: JSON.stringify(body),
          signal: abortController.signal
        });
        // Keep the deadline active until the complete body is consumed. Fetch can
        // resolve as soon as headers arrive while a provider stalls the body stream.
        text = await response.text();
      } catch (error) {
        if (timedOut) {
          logger.warn(
            {
              provider: "openrouter",
              path,
              timeoutMs,
              attempt,
              maxAttempts,
              durationMs: durationMs(startedAt)
            },
            "OpenRouter request timed out"
          );
          throw new OpenRouterTimeoutError({ timeoutMs, path, cause: error });
        }
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error(`OpenRouter request aborted (${path}).`, { cause: error });
        }
        if (attempt < maxAttempts && isTransientFetchError(error) && options.retryPolicy !== "expensive") {
          const retryDelayMs = OPENROUTER_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ?? 0;
          logger.warn(
            {
              provider: "openrouter",
              path,
              attempt,
              maxAttempts,
              retryDelayMs,
              durationMs: durationMs(startedAt),
              error: error instanceof Error ? error.message : String(error)
            },
            "OpenRouter network request failed; retrying"
          );
          await sleep(retryDelayMs);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", forwardAbort);
      }

      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }

      if (!response.ok) {
        const details = openRouterErrorDetails(response.status, json, text);
        logger.warn(
          {
            provider: "openrouter",
            path,
            status: response.status,
            attempt,
            maxAttempts,
            durationMs: durationMs(startedAt),
            totalDurationMs: durationMs(totalStartedAt),
            code: details.code,
            error: details.message
          },
          "OpenRouter request failed"
        );
        if (isContentFilterSignal(details.message) || isContentFilterSignal(details.code)) {
          throw new OpenRouterContentFilterError({
            status: response.status,
            model: typeof body.model === "string" ? body.model : undefined,
            message: details.message
          });
        }
        if (attempt < maxAttempts && isRetryableOpenRouterStatus(response.status)) {
          const retryDelayMs = retryDelayMsForResponse(response, attempt, options.retryPolicy ?? "cheap");
          if (retryDelayMs == null) {
            throw new Error(`OpenRouter request failed (${response.status}): ${details.message}`);
          }
          logger.warn(
            {
              provider: "openrouter",
              path,
              status: response.status,
              attempt,
              maxAttempts,
              retryDelayMs,
              code: details.code
            },
            "OpenRouter transient request failed; retrying"
          );
          await sleep(retryDelayMs);
          continue;
        }
        throw new Error(`OpenRouter request failed (${response.status}): ${details.message}`);
      }

      logger.debug(
        {
          provider: "openrouter",
          path,
          status: response.status,
          attempt,
          maxAttempts,
          durationMs: durationMs(startedAt),
          totalDurationMs: durationMs(totalStartedAt)
        },
        "OpenRouter HTTP request complete"
      );

      return json;
    }

    throw new Error("OpenRouter request failed after retries.");
  }
}

function messagesForPromptCaching(model: string, messages: ChatMessage[]): ChatMessage[] {
  if (!model.startsWith("anthropic/")) return messages;
  const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  if (firstSystemIndex < 0) return messages;
  return messages.map((message, index) => {
    if (index !== firstSystemIndex || typeof message.content !== "string") return message;
    return {
      ...message,
      content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }]
    };
  });
}

export class OpenRouterContentFilterError extends Error {
  readonly status?: number;
  readonly model?: string;
  readonly finishReason?: string;

  constructor(input: { status?: number; model?: string; finishReason?: string; message?: string }) {
    super(input.message ?? "OpenRouter response was blocked by a content filter.");
    this.name = "OpenRouterContentFilterError";
    this.status = input.status;
    this.model = input.model;
    this.finishReason = input.finishReason;
  }
}

export class OpenRouterTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly path: string;

  constructor(input: { timeoutMs: number; path: string; cause?: unknown }) {
    super(`OpenRouter request timed out after ${input.timeoutMs}ms (${input.path}).`, { cause: input.cause });
    this.name = "OpenRouterTimeoutError";
    this.timeoutMs = input.timeoutMs;
    this.path = input.path;
  }
}

export function isOpenRouterTimeoutError(error: unknown): error is OpenRouterTimeoutError {
  return error instanceof OpenRouterTimeoutError;
}

export function isOpenRouterContentFilterError(error: unknown): error is OpenRouterContentFilterError {
  return error instanceof OpenRouterContentFilterError;
}

function extractEstimatedCostUsd(json: any): number | undefined {
  const usage = json?.usage;
  const rawCost = usage?.cost ?? usage?.total_cost ?? usage?.cost_usd ?? usage?.total_cost_usd;
  const cost = typeof rawCost === "string" ? Number(rawCost) : rawCost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

function extractTokenUsage(json: any): OpenRouterTokenUsage | undefined {
  const usage = json?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const normalized: OpenRouterTokenUsage = {
    inputTokens: firstNumber(usage.prompt_tokens, usage.input_tokens, usage.inputTokens),
    outputTokens: firstNumber(usage.completion_tokens, usage.output_tokens, usage.outputTokens),
    totalTokens: firstNumber(usage.total_tokens, usage.totalTokens),
    reasoningTokens: firstNumber(usage.reasoning_tokens, usage.reasoningTokens),
    cachedInputTokens: firstNumber(
      usage.cached_tokens,
      usage.cached_input_tokens,
      usage.cachedInputTokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens,
      usage.cache_read_input_tokens
    )
  };
  const compact = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value != null)) as OpenRouterTokenUsage;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed === "number" && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function finishReasonFromChoice(choice: any): string | undefined {
  const value = choice?.finish_reason ?? choice?.finishReason ?? choice?.native_finish_reason;
  return value == null ? undefined : String(value);
}

function isContentFilterSignal(value: unknown) {
  return /\b(?:content[_ -]?filter(?:ed)?|prohibited[_ -]?content|safety[_ -]?(?:filter|policy|block(?:ed)?))\b/i.test(String(value ?? ""));
}

function isRetryableOpenRouterStatus(status: number) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

function isTransientFetchError(error: unknown) {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|network|socket|econnreset|etimedout/i.test(message);
}

function retryDelayMsForResponse(response: Response, attempt: number, retryPolicy: OpenRouterRetryPolicy) {
  const retryAfterHeader = response.headers?.get?.("retry-after");
  const retryAfterSeconds = retryAfterHeader == null ? undefined : Number(retryAfterHeader);
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    const retryDelayMs = retryAfterSeconds * 1000;
    if (retryPolicy === "expensive" && (attempt > 1 || retryDelayMs > 5_000)) return undefined;
    return Math.min(retryDelayMs, 5_000);
  }
  if (retryPolicy === "expensive" && response.status === 429) return undefined;
  return OPENROUTER_TRANSIENT_RETRY_DELAYS_MS[attempt - 1] ?? 0;
}

function openRouterErrorDetails(status: number, json: any, text: string): { message: string; code?: string } {
  const rawMessage = firstString(json?.error?.message, json?.message);
  const rawCode = firstString(json?.error?.code, json?.code, json?.error?.metadata?.reason);
  const message = sanitizeOpenRouterErrorMessage(rawMessage ?? text, status);
  return {
    message,
    code: rawCode == null ? undefined : sanitizePlainText(rawCode).slice(0, 120)
  };
}

function sanitizeOpenRouterErrorMessage(raw: string, status: number) {
  const trimmed = raw.trim();
  if (!trimmed) return `HTTP ${status}`;
  if (/<html[\s>]|<!doctype html/i.test(trimmed)) {
    return summarizeHtmlError(trimmed) ?? `HTML error response from OpenRouter (HTTP ${status})`;
  }
  return sanitizePlainText(trimmed).slice(0, 500);
}

function summarizeHtmlError(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
  const cfCode = html.match(/cf-error-code[^>]*>\s*([0-9]{3,4})\s*</i)?.[1] ?? html.match(/Error\s*([0-9]{3,4})/i)?.[1];
  const base = sanitizePlainText(title ?? heading ?? "");
  const conciseBase = base.replace(/\s*\|\s*openrouter\.ai\s*\|\s*Cloudflare\s*$/i, "").trim();
  if (!conciseBase) return cfCode ? `Cloudflare error ${cfCode}` : undefined;
  return cfCode ? `${conciseBase} (Cloudflare ${cfCode})` : conciseBase;
}

function sanitizePlainText(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&bull;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

async function sleep(ms: number) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function countChatImageInputs(messages: ChatMessage[]) {
  return messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) return total;
    return total + message.content.filter((part) => part.type === "image_url").length;
  }, 0);
}

function parseDsmlToolCalls(content: string): ChatResult["toolCalls"] {
  if (!content.includes("DSML") || !content.includes("invoke name=")) return [];
  const invokePattern = /<[^>]*DSML[^>]*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*invoke>/g;
  const parameterPattern = /<[^>]*DSML[^>]*parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*parameter>/g;
  const calls: ChatResult["toolCalls"] = [];
  let invoke: RegExpExecArray | null;
  while ((invoke = invokePattern.exec(content)) != null) {
    const [, name, body] = invoke;
    const args: Record<string, unknown> = {};
    let parameter: RegExpExecArray | null;
    while ((parameter = parameterPattern.exec(body)) != null) {
      const [, parameterName, stringFlag, rawValue] = parameter;
      const value = decodeXmlText(rawValue.trim());
      args[parameterName] = stringFlag === "false" ? parseJsonishValue(value) : value;
    }
    calls.push({
      id: `dsml_call_${calls.length + 1}`,
      name,
      argumentsText: JSON.stringify(args)
    });
  }
  return calls;
}

function stripDsmlToolCalls(content: string) {
  return content.replace(/<[^>]*DSML[^>]*tool_calls[^>]*>[\s\S]*?<\/[^>]*DSML[^>]*tool_calls>/g, "");
}

function parseJsonishValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeXmlText(value: string) {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
