import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  hydrateProfileFromOfficialDocumentation,
  hydrateProfileFromAdvertisedOpenApi,
  MppDiscoveryClient,
  operationsFromOpenApi
} from "../../src/payments/mppDiscoveryClient.js";

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

  it("hydrates an MCP registry summary from the service's advertised OpenAPI document", async () => {
    const config = loadConfig().payments.mpp;
    config.maxResponseBytes = 2_000_000;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({
      openapi: "3.1.0",
      info: { title: "Company Enrichment", version: "1" },
      paths: {
        "/companies/enrich": {
          get: {
            operationId: "enrich_company",
            parameters: [
              { name: "domain", in: "query", required: true, schema: { type: "string" } }
            ],
            "x-payment-info": {
              offers: [{ method: "mpp", intent: "charge", currency: "USD" }]
            },
            responses: { "200": { description: "Company profile" } }
          }
        }
      }
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const hydrated = await hydrateProfileFromAdvertisedOpenApi({
      serviceId: "company-enrich",
      name: "Company Enrichment",
      description: "Company data",
      baseUrl: "https://8.8.8.8/mpp/company-enrich",
      categories: ["data"],
      status: "active",
      documentation: null,
      discoverySource: "services_mcp",
      limitations: ["The directory returned a registry summary rather than a full OpenAPI document; request fields may be incomplete."],
      operations: [{
        operationId: "get_companies_enrich",
        method: "GET",
        path: "/companies/enrich",
        summary: "Enrich a company",
        requestShape: null,
        offers: [{
          method: "tempo",
          intent: "charge",
          currency: "0xtoken",
          amount: "10000",
          decimals: 6,
          display: "0.01 0xtoken",
          unitType: "request",
          dynamic: false
        }]
      }]
    }, config, fetchImpl);

    const request = fetchMock.mock.calls[0]?.[0];
    expect(request instanceof URL ? request.href : request instanceof Request ? request.url : request)
      .toBe("https://8.8.8.8/mpp/company-enrich/openapi.json");
    expect(hydrated.limitations).toEqual([]);
    expect(hydrated.operations).toEqual([
      expect.objectContaining({
        operationId: "enrich_company",
        requestShape: "query domain:string required",
        offers: [expect.objectContaining({ amount: "10000" })]
      })
    ]);
  });

  it("hydrates missing request schemas from the most relevant official llms.txt page", async () => {
    const config = loadConfig().payments.mpp;
    const fetchImpl = vi.fn(async (target: string | URL | Request) => {
      const url = new URL(target instanceof Request ? target.url : target.toString());
      if (url.pathname === "/llms.txt") {
        return new Response([
          "# Provider API docs",
          "- [Google Flights API](https://8.8.8.8/google-flights-api.md): Exact date flight search.",
          "- [Google Flights Deals API](https://8.8.8.8/google-flights-deals-api.md): Flexible dates and lowest prices."
        ].join("\n"));
      }
      if (url.pathname === "/google-flights-deals-api.md") {
        return new Response("# Google Flights Deals API\n`engine=google_flights_deals`\n`stops=1` means nonstop only.");
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
    const profile = await hydrateProfileFromOfficialDocumentation({
      serviceId: "serpapi",
      name: "SerpApi",
      description: "Google Flights search with real-time prices",
      baseUrl: "https://1.1.1.1/mpp/serpapi",
      categories: ["search"],
      status: "active",
      operations: [{
        operationId: "get_search",
        method: "GET",
        path: "/search",
        summary: "Google Flights search",
        requestShape: null,
        offers: []
      }],
      documentation: null,
      discoverySource: "services_mcp",
      limitations: []
    }, {
      id: "serpapi",
      url: "https://8.8.8.8"
    }, "cheapest nonstop round-trip flights with flexible fall dates", config, fetchImpl);

    expect(profile.documentation).toEqual(expect.objectContaining({
      pageUrl: "https://8.8.8.8/google-flights-deals-api.md",
      title: "Google Flights Deals API",
      excerpt: expect.stringContaining("stops=1")
    }));
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
