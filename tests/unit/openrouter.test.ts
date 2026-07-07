import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterClient, OpenRouterContentFilterError } from "../../src/models/openrouter.js";

const config = {
  apiKey: "test-key",
  baseUrl: "https://openrouter.test/api/v1",
  appTitle: "Discord AI Agent Test",
  httpReferer: "http://localhost",
  chatModel: "test/chat",
  codegenModel: "test/codegen",
  embeddingModel: "test/embed",
  imageModel: "test/image"
};

describe("OpenRouterClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends embedding dimensions", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2] }] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    await expect(client.embed(["hello"], "test/embed", 2)).resolves.toEqual([[0.1, 0.2]]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/embeddings",
      expect.objectContaining({
        body: JSON.stringify({ model: "test/embed", input: ["hello"], dimensions: 2 })
      })
    );
  });

  it("uses the OpenRouter image endpoint and parses cost estimates", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "test/image",
        data: [{ url: "https://example.com/a.png" }],
        usage: { cost: "0.0123" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    await expect(client.generateImage("blue square")).resolves.toMatchObject({
      model: "test/image",
      data: [{ url: "https://example.com/a.png" }],
      estimatedCostUsd: 0.0123
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/images",
      expect.objectContaining({
        body: JSON.stringify({ model: "test/image", prompt: "blue square" })
      })
    );
  });

  it("maps optional image generation settings to OpenRouter fields", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    await client.generateImage("transparent logo", {
      inputReferences: [{ type: "image_url", image_url: { url: "https://cdn.discordapp.com/ref.png" } }],
      resolution: "1K",
      aspectRatio: "1:1",
      quality: "high",
      outputFormat: "png",
      background: "transparent",
      n: 1
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/images",
      expect.objectContaining({
        body: JSON.stringify({
          model: "test/image",
          prompt: "transparent logo",
          resolution: "1K",
          input_references: [{ type: "image_url", image_url: { url: "https://cdn.discordapp.com/ref.png" } }],
          aspect_ratio: "1:1",
          quality: "high",
          output_format: "png",
          background: "transparent",
          n: 1
        })
      })
    );
  });

  it("sends tool definitions and parses tool calls", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "test/chat",
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  function: {
                    name: "searchDiscordHistory",
                    arguments: "{\"query\":\"pizza\"}"
                  }
                }
              ]
            }
          }
        ],
        usage: {
          cost_usd: 0.0042,
          prompt_tokens: 11,
          completion_tokens: 4,
          total_tokens: 15,
          reasoning_tokens: "2",
          prompt_tokens_details: { cached_tokens: 3 }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const result = await client.chat({
      messages: [{ role: "user", content: "search pizza" }],
      tools: [
        {
          type: "function",
          function: {
            name: "searchDiscordHistory",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"]
            }
          }
        }
      ]
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        name: "searchDiscordHistory",
        argumentsText: "{\"query\":\"pizza\"}"
      }
    ]);
    expect(result.estimatedCostUsd).toBe(0.0042);
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 4,
      totalTokens: 15,
      reasoningTokens: 2,
      cachedInputTokens: 3
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openrouter.test/api/v1/chat/completions",
      expect.objectContaining({
        body: expect.stringContaining("\"tools\"")
      })
    );
  });

  it("retries transient OpenRouter 503 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(503, cloudflareWorkerLimitHtml()))
      .mockResolvedValueOnce(
        jsonResponse({
          model: "test/chat",
          choices: [{ message: { content: "The US are still the real winners because vibes." } }]
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const request = client.chat({ messages: [{ role: "user", content: "explain why the US are still the real winners" }] });

    await vi.runAllTimersAsync();

    await expect(request).resolves.toMatchObject({
      content: "The US are still the real winners because vibes."
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sanitizes exhausted HTML provider errors", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => htmlResponse(503, cloudflareWorkerLimitHtml()));
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const request = client.chat({ messages: [{ role: "user", content: "hello" }] });
    const assertion = expect(request).rejects.toThrow("OpenRouter request failed (503): Worker exceeded resource limits (Cloudflare 1102)");

    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("aborts chat requests that exceed the hard timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const request = client.chat({ messages: [{ role: "user", content: "hello" }] });
    const assertion = expect(request).rejects.toThrow("OpenRouter request timed out after 45000ms");

    await vi.advanceTimersByTimeAsync(45_000);

    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it("parses DeepSeek DSML tool calls emitted as text", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "test/chat",
        choices: [
          {
            message: {
              content:
                '<｜｜DSML｜｜tool_calls>\n' +
                '<｜｜DSML｜｜invoke name="searchDiscordHistory">\n' +
                '<｜｜DSML｜｜parameter name="query" string="true">new job started</｜｜DSML｜｜parameter>\n' +
                '<｜｜DSML｜｜parameter name="limit" string="false">20</｜｜DSML｜｜parameter>\n' +
                "</｜｜DSML｜｜invoke>\n" +
                "</｜｜DSML｜｜tool_calls>"
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const result = await client.chat({
      messages: [{ role: "user", content: "search jobs" }],
      tools: [
        {
          type: "function",
          function: {
            name: "searchDiscordHistory",
            parameters: {
              type: "object",
              properties: { query: { type: "string" }, limit: { type: "number" } }
            }
          }
        }
      ]
    });

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([
      {
        id: "dsml_call_1",
        name: "searchDiscordHistory",
        argumentsText: "{\"query\":\"new job started\",\"limit\":20}"
      }
    ]);
  });

  it("strips DSML tool-call markup from content when tools are not available", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "test/chat",
        choices: [
          {
            message: {
              content:
                '<｜｜DSML｜｜tool_calls>\n' +
                '<｜｜DSML｜｜invoke name="searchDiscordHistory">\n' +
                '<｜｜DSML｜｜parameter name="query" string="true">new job started</｜｜DSML｜｜parameter>\n' +
                "</｜｜DSML｜｜invoke>\n" +
                "</｜｜DSML｜｜tool_calls>"
            }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    const result = await client.chat({
      messages: [{ role: "user", content: "final answer only" }]
    });

    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([]);
  });

  it("throws a typed error when chat finishes with content_filter", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        model: "test/chat",
        choices: [
          {
            finish_reason: "content_filter",
            message: { content: "" }
          }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    await expect(client.chat({ messages: [{ role: "user", content: "filtered" }] })).rejects.toBeInstanceOf(OpenRouterContentFilterError);
  });

  it("throws a typed error when OpenRouter returns a content filter error body", async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { code: "content_filter", message: "content_filter" } })
      }) as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenRouterClient(config);
    await expect(client.chat({ messages: [{ role: "user", content: "filtered" }] })).rejects.toMatchObject({
      name: "OpenRouterContentFilterError",
      status: 400,
      model: "test/chat"
    });
  });
});

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body)
  } as Response;
}

function htmlResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => body
  } as Response;
}

function cloudflareWorkerLimitHtml() {
  return `<!DOCTYPE html>
<html>
<head><title>Worker exceeded resource limits | openrouter.ai | Cloudflare</title></head>
<body>
<span class="cf-error-code">1102</span>
<span id="cf-footer-ip">203.0.113.10</span>
</body>
</html>`;
}
