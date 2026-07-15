import { Challenge, Receipt } from "mppx";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import type { PaymentRepository } from "../../src/db/paymentRepository.js";
import type { MppDiscoveryClient, MppServiceProfile } from "../../src/payments/mppDiscoveryClient.js";
import { MppService, mppAuthorizationAmount } from "../../src/payments/mppService.js";
import type { WalletService } from "../../src/payments/walletService.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const currency = `0x${"33".repeat(20)}`;
const recipient = `0x${"22".repeat(20)}`;

function profile(): MppServiceProfile {
  return {
    serviceId: "weather",
    name: "Weather",
    description: "Paid forecasts",
    baseUrl: "https://8.8.8.8/api",
    categories: ["data"],
    status: "active",
    discoverySource: "services_mcp",
    limitations: [],
    operations: [
      {
        operationId: "get_forecast",
        method: "GET",
        path: "/forecast/{city}",
        summary: "Current forecast",
        requestShape: "path city:string required; query units:string",
        offers: [{ method: "tempo", intent: "charge", currency, amount: "1000", decimals: 6, display: "$0.001", unitType: "request", dynamic: false }]
      },
      {
        operationId: "post_search",
        method: "POST",
        path: "/search",
        summary: "Read-only weather search",
        requestShape: "JSON {query:string!}",
        offers: []
      },
      {
        operationId: "delete_alert",
        method: "DELETE",
        path: "/alerts/{id}",
        summary: "Delete an alert",
        requestShape: "path id:string required",
        offers: []
      }
    ]
  };
}

function setup(fetchImpl?: typeof fetch) {
  const repo = {
    beginMppAttempt: vi.fn(async () => ({ id: "mpp_test", status: "started", duplicate: false })),
    authorizeMppPayment: vi.fn(async () => ({ amountUsdMicros: 0n })),
    getChannelValue: vi.fn(async () => null),
    setChannelValue: vi.fn(async () => undefined),
    withMppSessionLock: vi.fn(async (_guildId: string, _chainId: number, action: () => Promise<unknown>) => action()),
    markMppAttempt: vi.fn(async () => undefined)
  } as unknown as PaymentRepository;
  const client = createClient({ account, chain: tempoModerato, transport: http("http://127.0.0.1") });
  const wallets = {
    getBotMppPaymentContext: vi.fn(async () => ({
      account,
      getClient: () => client,
      wallet: { chainId: tempoModerato.id }
    })),
    resolveToken: vi.fn(async () => ({ symbol: "pathUSD", address: currency, decimals: 6, currency: "USD" }))
  } as unknown as WalletService;
  const discovery = {
    discover: vi.fn(async () => ({
      source: "services_mcp" as const,
      recommendations: [{
        serviceId: "weather",
        name: "Weather",
        description: "Paid forecasts",
        baseUrl: "https://8.8.8.8/api",
        categories: ["data"],
        status: "active",
        score: 42,
        reasons: ["Matched forecast"],
        topOffers: [{ method: "GET", path: "/forecast/{city}", summary: "Current forecast", price: "$0.001" }]
      }]
    })),
    inspectService: vi.fn(async () => profile()),
    inspectDirect: vi.fn(async () => profile())
  } as unknown as MppDiscoveryClient;
  const config = loadConfig().payments;
  config.mpp.autoApproveUsd = 0.05;
  const fallbackFetch = vi.fn(async () => Response.json({ forecast: "sunny" })) as unknown as typeof fetch;
  const service = new MppService(config, repo, wallets, fetchImpl ?? fallbackFetch, discovery);
  return { service, repo, wallets, discovery, fetchImpl: fetchImpl ?? fallbackFetch };
}

async function inspect(service: MppService): Promise<string> {
  const result = await service.inspect("weather");
  const inspectionId = result.match(/Inspection ID: (mppi_[\w-]+)/)?.[1];
  if (!inspectionId) throw new Error("inspection id missing from test result");
  return inspectionId;
}

function paymentChallenge(amount = "0") {
  return Challenge.from({
    id: `challenge-${amount}`,
    realm: "8.8.8.8",
    method: "tempo",
    intent: "charge",
    request: {
      amount,
      currency,
      decimals: 6,
      recipient,
      methodDetails: { chainId: tempoModerato.id }
    }
  });
}

function paidFetch(options: { amount?: string; includeReceipt?: boolean } = {}): typeof fetch {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": Challenge.serialize(paymentChallenge(options.amount ?? "0")) }
      });
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (options.includeReceipt !== false) {
      headers.set("Payment-Receipt", Receipt.serialize(Receipt.from({
        method: "tempo",
        reference: "0xreceipt",
        status: "success",
        timestamp: new Date().toISOString()
      })));
    }
    return new Response(JSON.stringify({ forecast: "sunny" }), { status: 200, headers });
  }) as unknown as typeof fetch;
}

describe("MppService", () => {
  it("budgets a session's bounded opening deposit rather than only its first unit price", () => {
    expect(mppAuthorizationAmount({ amount: "10000", suggestedDeposit: "400000" }, "session", 6, 0.5)).toBe(400_000n);
    expect(mppAuthorizationAmount({ amount: "10000", suggestedDeposit: "900000" }, "session", 6, 0.5)).toBe(500_000n);
    expect(mppAuthorizationAmount({ amount: "10000" }, "charge", 6, 0.5)).toBe(10_000n);
  });

  it("uses ranked discovery and returns an inspection token, request shapes, and all offer metadata", async () => {
    const { service } = setup();
    await expect(service.discover({ query: "forecast" })).resolves.toContain("Why: Matched forecast");
    const inspected = await service.inspect("weather");
    expect(inspected).toMatch(/Inspection ID: mppi_/);
    expect(inspected).toContain("GET /forecast/{city} (get_forecast)");
    expect(inspected).toContain("path city:string required");
    expect(inspected).toContain("tempo/charge $0.001");
  });

  it("calls only an inspected operation and labels free response data as untrusted", async () => {
    const { service, repo } = setup();
    const inspectionId = await inspect(service);
    const result = await service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "forecast New York" },
      { inspectionId, operationId: "get_forecast", pathParams: { city: "New York" }, effect: "read_only" }
    );
    expect(result.content).toContain("<external_mpp_data>");
    expect(result.content).toContain("untrusted external service data");
    expect(repo.beginMppAttempt).toHaveBeenCalledWith(expect.objectContaining({
      inspectionId,
      operationId: "get_forecast",
      requestUrl: "https://8.8.8.8/api/forecast/New%20York"
    }));
  });

  it("rejects operations that were not part of the fresh inspection", async () => {
    const { service } = setup();
    const inspectionId = await inspect(service);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "forecast" },
      { inspectionId, operationId: "missing", effect: "read_only" }
    )).rejects.toThrow(/was not part of inspection/);
  });

  it("validates and persists Payment-Receipt before marking a paid response successful", async () => {
    const fetchImpl = paidFetch();
    const { service, repo } = setup(fetchImpl);
    const inspectionId = await inspect(service);
    const result = await service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "forecast NYC" },
      { inspectionId, operationId: "get_forecast", pathParams: { city: "NYC" }, effect: "read_only" }
    );
    expect(result.content).toContain("Payment receipt: tempo 0xreceipt");
    expect(repo.authorizeMppPayment).toHaveBeenCalledWith(expect.objectContaining({ approvalMode: "automatic_low_cost" }));
    expect(repo.markMppAttempt).toHaveBeenCalledWith("mpp_test", "paid", expect.objectContaining({
      receipt: expect.objectContaining({ reference: "0xreceipt", status: "success" })
    }));
  });

  it("marks a paid retry uncertain when Payment-Receipt is absent", async () => {
    const { service, repo } = setup(paidFetch({ includeReceipt: false }));
    const inspectionId = await inspect(service);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "forecast NYC" },
      { inspectionId, operationId: "get_forecast", pathParams: { city: "NYC" }, effect: "read_only" }
    )).rejects.toThrow(/receipt/i);
    expect(repo.markMppAttempt).toHaveBeenCalledWith("mpp_test", "uncertain", expect.any(Object));
  });

  it("requires explicit current-request authorization above the automatic payment threshold", async () => {
    const { service, repo } = setup(paidFetch({ amount: "60000" }));
    const inspectionId = await inspect(service);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "forecast NYC" },
      { inspectionId, operationId: "get_forecast", pathParams: { city: "NYC" }, effect: "read_only" }
    )).rejects.toThrow(/Explicit user authorization/);
    expect(repo.authorizeMppPayment).not.toHaveBeenCalled();
  });

  it("requires a verbatim authorization quote for external side effects", async () => {
    const { service } = setup();
    const inspectionId = await inspect(service);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "delete alert 123" },
      { inspectionId, operationId: "delete_alert", pathParams: { id: "123" }, effect: "external_side_effect" }
    )).rejects.toThrow(/userAuthorization/);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution-2", requestText: "please delete alert 123" },
      {
        inspectionId,
        operationId: "delete_alert",
        pathParams: { id: "123" },
        effect: "external_side_effect",
        userAuthorization: "delete alert 123"
      }
    )).resolves.toEqual(expect.objectContaining({ status: "ok" }));
  });

  it("allows POST-based searches to be classified as read-only", async () => {
    const { service } = setup();
    const inspectionId = await inspect(service);
    await expect(service.call(
      { guildId: "guild", userId: "user", executionId: "execution", requestText: "search weather" },
      { inspectionId, operationId: "post_search", body: { query: "rain" }, effect: "read_only" }
    )).resolves.toEqual(expect.objectContaining({ status: "ok" }));
  });
});
