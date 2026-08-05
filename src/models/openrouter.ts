import type { AppConfig } from "../config/env.js";
import { durationMs, logger } from "../util/logger.js";
import { openRouterReasoning, openRouterTemperature, type OpenRouterReasoningEffort } from "./openrouterReasoning.js";
import { fetchOpenRouterModels, type OpenRouterModel } from "./openrouterModels.js";
import { transcribeAudioViaOpenRouter, type TranscriptionInput, type TranscriptionResult } from "./openrouterTranscription.js";
import { extractEstimatedCostUsd, extractTokenUsage, type OpenRouterTokenUsage } from "./openrouterUsage.js";
import {
  OpenRouterContentFilterError,
  OpenRouterHttpError,
  OpenRouterTimeoutError,
} from "./openrouterErrors.js";
import {
  extractServerToolUse,
  extractUrlCitations,
  finishReasonFromChoice,
  isContentFilterSignal,
  openRouterErrorDetails,
  type OpenRouterUrlCitation,
} from "./openrouterResponse.js";

export {
  isOpenRouterContentFilterError,
  isOpenRouterHttpError,
  isOpenRouterTimeoutError,
  OpenRouterContentFilterError,
  OpenRouterHttpError,
  OpenRouterTimeoutError,
} from "./openrouterErrors.js";

export type { TranscriptionResult } from "./openrouterTranscription.js";
export type { OpenRouterReasoningEffort } from "./openrouterReasoning.js";
export type { OpenRouterTokenUsage } from "./openrouterUsage.js";
export type { OpenRouterModel } from "./openrouterModels.js";
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
  serverToolUse?: Record<string, number>;
  urlCitations?: OpenRouterUrlCitation[];
  estimatedCostUsd?: number;
  toolCalls: Array<{
    id: string;
    name: string;
    argumentsText: string;
  }>;
};

export type { OpenRouterUrlCitation } from "./openrouterResponse.js";

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

  async listModels(options: { signal?: AbortSignal } = {}): Promise<OpenRouterModel[]> {
    return fetchOpenRouterModels(
      (path, body, timeoutMs, requestOptions) =>
        this.request(path, body, timeoutMs, requestOptions),
      options.signal,
    );
  }

  async chat(input: {
    messages: ChatMessage[];
    model?: string;
    tools?: ToolDefinition[];
    toolChoice?: ToolChoice;
    temperature?: number;
    maxTokens?: number;
    reasoningEffort?: OpenRouterReasoningEffort;
    retryPolicy?: OpenRouterRetryPolicy;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    const startedAt = Date.now();
    const model = input.model ?? this.config.chatModel;
    const temperature = openRouterTemperature(
      input.reasoningEffort,
      input.temperature,
    );
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
        timeoutMs: input.timeoutMs ?? OPENROUTER_CHAT_TIMEOUT_MS,
        temperature,
        reasoningEffort: input.reasoningEffort
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
        temperature,
        max_tokens: input.maxTokens ?? 4096,
        reasoning: openRouterReasoning(input.reasoningEffort)
      },
      input.timeoutMs ?? OPENROUTER_CHAT_TIMEOUT_MS,
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
    const toolCalls = structuredToolCalls;
    const content = rawContent;

    const result: ChatResult = {
      content,
      model: String(json.model ?? model),
      raw: json,
      finishReason,
      usage: extractTokenUsage(json),
      serverToolUse: extractServerToolUse(json),
      urlCitations: extractUrlCitations(message),
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
        serverToolUse: result.serverToolUse,
        urlCitationCount: result.urlCitations?.length ?? 0,
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

  async transcribeAudio(input: TranscriptionInput): Promise<TranscriptionResult> {
    return transcribeAudioViaOpenRouter(input, this.config.transcriptionModel, (path, body, timeoutMs, options) =>
      this.request(path, body, timeoutMs, options));
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    options: {
      retryPolicy?: OpenRouterRetryPolicy;
      maxAttempts?: number;
      signal?: AbortSignal;
      method?: "GET" | "POST";
    } = {}
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
          method: options.method ?? "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": this.config.httpReferer,
            "X-Title": this.config.appTitle
          },
          body: options.method === "GET" ? undefined : JSON.stringify(body),
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
            throw new OpenRouterHttpError({ status: response.status, message: details.message, code: details.code });
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
        throw new OpenRouterHttpError({ status: response.status, message: details.message, code: details.code });
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
