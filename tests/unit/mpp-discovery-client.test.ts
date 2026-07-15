import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { MppDiscoveryClient, operationsFromOpenApi } from "../../src/payments/mppDiscoveryClient.js";

describe("MPP discovery", () => {
  it("normalizes current multi-offer OpenAPI metadata and request schemas", () => {
    const operations = operationsFromOpenApi({
      openapi: "3.1.0",
      info: { title: "Search", version: "1" },
      paths: {
        "/search/{index}": {
          post: {
            operationId: "search_index",
            summary: "Search an index",
            parameters: [
              { name: "index", in: "path", required: true, schema: { type: "string" } },
              { name: "limit", in: "query", schema: { type: "integer" } }
            ],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["query"],
                    properties: { query: { type: "string" }, filters: { type: "object" } }
                  }
                }
              }
            },
            "x-payment-info": {
              offers: [
                { method: "tempo", intent: "charge", amount: "2000", currency: "0xtoken", decimals: 6, unitType: "request" },
                { method: "tempo", intent: "session", amount: "5000", currency: "0xtoken", decimals: 6, unitType: "token" }
              ]
            }
          }
        }
      }
    });
    expect(operations).toEqual([
      expect.objectContaining({
        operationId: "search_index",
        method: "POST",
        path: "/search/{index}",
        requestShape: expect.stringContaining("path index:string required"),
        offers: [
          expect.objectContaining({ method: "tempo", intent: "charge", amount: "2000", dynamic: false }),
          expect.objectContaining({ method: "tempo", intent: "session", amount: "5000", dynamic: false })
        ]
      })
    ]);
    expect(operations[0]?.requestShape).toContain("JSON {query:string!, filters:object} required");
  });

  it("falls back to the public catalog and prefers the callable serviceUrl over the provider homepage", async () => {
    const config = loadConfig().payments.mpp;
    config.serviceDiscoveryMcpUrl = "https://1.1.1.1/mcp";
    config.serviceCatalogUrl = "https://8.8.8.8/catalog";
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      const url = new URL(target instanceof Request ? target.url : target.toString());
      if (url.hostname === "1.1.1.1") return new Response("unavailable", { status: 503 });
      if (url.pathname === "/catalog") {
        return Response.json({ services: [{
          id: "search",
          name: "Search",
          description: "Search the web",
          url: "https://provider.example",
          serviceUrl: "https://8.8.8.8/mpp/search",
          categories: ["search"],
          status: "active",
          endpoints: [{ method: "POST", path: "/query", payment: { amount: "2000", decimals: 6, currency: "0xtoken" } }]
        }] });
      }
      if (url.pathname === "/mpp/search/openapi.json") {
        return Response.json({
          openapi: "3.1.0",
          info: { title: "Search", version: "1" },
          paths: { "/query": { post: { operationId: "query", responses: { "402": {} } } } }
        });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
    const client = new MppDiscoveryClient(config, fetchImpl);
    const discovered = await client.discover({ query: "search" });
    expect(discovered.source).toBe("catalog_fallback");
    expect(discovered.recommendations[0]?.baseUrl).toBe("https://8.8.8.8/mpp/search");
    const inspected = await client.inspectService("search");
    expect(inspected.baseUrl).toBe("https://8.8.8.8/mpp/search");
    expect(inspected.operations).toEqual(expect.arrayContaining([expect.objectContaining({ operationId: "query" })]));
  });
});
