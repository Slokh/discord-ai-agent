import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DiscoveryDocument } from "mppx/discovery";
import type { AppConfig } from "../config/env.js";
import { assertPublicHttpsUrl, safeFetch } from "./safeHttp.js";

export type MppPaymentOffer = {
  method: string | null;
  intent: string | null;
  currency: string | null;
  amount: string | null;
  decimals: number | null;
  display: string | null;
  unitType: string | null;
  dynamic: boolean;
};

export type MppOperation = {
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  requestShape: string | null;
  offers: MppPaymentOffer[];
};

export type MppServiceProfile = {
  serviceId: string;
  name: string;
  description: string;
  baseUrl: string;
  categories: string[];
  status: string | null;
  operations: MppOperation[];
  documentation: MppServiceDocumentation | null;
  discoverySource: "services_mcp" | "catalog_fallback" | "direct_openapi";
  limitations: string[];
};

export type MppServiceDocumentation = {
  indexUrl: string;
  pageUrl: string;
  title: string;
  excerpt: string;
};

export type MppRecommendation = {
  serviceId: string;
  name: string;
  description: string;
  baseUrl: string;
  categories: string[];
  status: string | null;
  score: number | null;
  reasons: string[];
  topOffers: Array<{ method: string; path: string; summary: string | null; price: string | null }>;
};

export class MppDiscoveryClient {
  constructor(
    private readonly config: AppConfig["payments"]["mpp"],
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async discover(input: { query?: string; category?: string; limit?: number }): Promise<{
    recommendations: MppRecommendation[];
    source: "services_mcp" | "catalog_fallback";
    limitation?: string;
  }> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 20));
    try {
      const structured = await this.callMcp(
        input.query?.trim() ? "recommend_services" : "search_services",
        input.query?.trim()
          ? {
              task: input.query.trim(),
              constraints: compactRecord({ category: normalizedCategory(input.category), method: "tempo", status: "active", limit })
            }
          : compactRecord({ category: normalizedCategory(input.category), method: "tempo", status: "active", limit })
      );
      const recommendations = normalizeRecommendations(structured, limit);
      return { recommendations, source: "services_mcp" };
    } catch (error) {
      return {
        recommendations: await this.discoverFromCatalog(input, limit),
        source: "catalog_fallback",
        limitation: `Services MCP unavailable; used the public catalog fallback (${errorMessage(error)}).`
      };
    }
  }

  async inspectService(serviceIdOrName: string, usageIntent?: string): Promise<MppServiceProfile> {
    try {
      const [recipe, openapi] = await this.callMcpBatch([
        ["get_usage_recipe", { service: serviceIdOrName }],
        ["get_openapi", { service: serviceIdOrName, raw: true }]
      ]);
      const profile = await hydrateProfileFromAdvertisedOpenApi(
        profileFromMcp(serviceIdOrName, recipe, openapi),
        this.config,
        this.fetchImpl
      );
      return await this.hydrateProfileDocumentation(profile, serviceIdOrName, usageIntent);
    } catch (error) {
      const profile = await this.inspectFromCatalog(serviceIdOrName, usageIntent);
      return {
        ...profile,
        limitations: [...profile.limitations, `Services MCP unavailable; used catalog/OpenAPI fallback (${errorMessage(error)}).`]
      };
    }
  }

  async inspectDirect(serviceUrl: string): Promise<MppServiceProfile> {
    const base = await assertPublicHttpsUrl(serviceUrl);
    const openapiUrl = new URL("openapi.json", base.toString().endsWith("/") ? base : new URL(`${base.toString()}/`));
    const response = await safeFetch(openapiUrl, {}, { allowedOrigin: base.origin, fetchImpl: this.fetchImpl });
    if (!response.ok) throw new Error(`Direct MPP service did not expose ${openapiUrl.pathname} (HTTP ${response.status})`);
    const document = await readBoundedJson(response, Math.min(this.config.maxResponseBytes, 1_000_000));
    const operations = operationsFromOpenApi(document);
    if (operations.length === 0) throw new Error("Direct MPP service OpenAPI document did not advertise callable operations");
    const info = isRecord(document) && isRecord(document.info) ? document.info : {};
    return {
      serviceId: base.hostname,
      name: stringValue(info.title) ?? base.hostname,
      description: stringValue(info.description) ?? "Direct MPP service",
      baseUrl: base.toString(),
      categories: [],
      status: null,
      operations,
      documentation: null,
      discoverySource: "direct_openapi",
      limitations: []
    };
  }

  private async callMcp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const [result] = await this.callMcpBatch([[name, args]]);
    return result;
  }

  private async callMcpBatch(calls: Array<[string, Record<string, unknown>]>): Promise<Record<string, unknown>[]> {
    const endpoint = await assertPublicHttpsUrl(this.config.serviceDiscoveryMcpUrl);
    const client = new Client({ name: "discord-ai-agent", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      fetch: (input, init) => safeFetch(input, init, { allowedOrigin: endpoint.origin, fetchImpl: this.fetchImpl }),
      reconnectionOptions: {
        maxReconnectionDelay: 2_000,
        initialReconnectionDelay: 250,
        reconnectionDelayGrowFactor: 2,
        maxRetries: 1
      }
    });
    await client.connect(transport);
    try {
      const results = await Promise.all(
        calls.map(async ([name, args]) => {
          const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 15_000, maxTotalTimeout: 20_000 });
          if ("toolResult" in result) throw new Error(`Unexpected task result from discovery tool ${name}`);
          if (result.isError) throw new Error(textContent(result.content) || `Discovery tool ${name} failed`);
          if (!isRecord(result.structuredContent)) throw new Error(`Discovery tool ${name} returned no structured content`);
          return result.structuredContent;
        })
      );
      return results;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async discoverFromCatalog(
    input: { query?: string; category?: string },
    limit: number
  ): Promise<MppRecommendation[]> {
    const rows = await this.catalogRows();
    const query = input.query?.trim().toLowerCase() ?? "";
    const category = normalizedCategory(input.category) ?? "";
    return rows
      .filter((row) => {
        const categories = stringArray(row.categories);
        return !category || categories.some((candidate) => candidate.toLowerCase() === category);
      })
      .filter((row) => {
        if (!query) return true;
        return [row.id, row.name, row.description, ...(stringArray(row.categories))]
          .map((value) => stringValue(value)?.toLowerCase() ?? "")
          .some((value) => value.includes(query));
      })
      .slice(0, limit)
      .map((row) => recommendationFromCatalog(row));
  }

  private async inspectFromCatalog(serviceIdOrName: string, usageIntent?: string): Promise<MppServiceProfile> {
    const row = (await this.catalogRows()).find((candidate) => {
      const requested = serviceIdOrName.toLowerCase();
      return stringValue(candidate.id)?.toLowerCase() === requested || stringValue(candidate.name)?.toLowerCase() === requested;
    });
    if (!row) throw new Error(`Unknown MPP service: ${serviceIdOrName}`);
    const baseUrl = serviceBaseUrl(row);
    if (!baseUrl) throw new Error(`MPP service ${serviceIdOrName} does not advertise a service URL`);
    let document: unknown = null;
    const limitations: string[] = [];
    const base = await assertPublicHttpsUrl(baseUrl);
    const configuredOpenApi = openApiUrl(row);
    const candidate = configuredOpenApi
      ? new URL(configuredOpenApi, base)
      : new URL("openapi.json", base.toString().endsWith("/") ? base : new URL(`${base.toString()}/`));
    try {
      if (candidate.origin !== base.origin) throw new Error("OpenAPI URL uses a different origin");
      const response = await safeFetch(candidate, {}, { allowedOrigin: base.origin, fetchImpl: this.fetchImpl });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      document = await readBoundedJson(response, Math.min(this.config.maxResponseBytes, 1_000_000));
    } catch (error) {
      limitations.push(`OpenAPI fetch failed: ${errorMessage(error)}`);
    }
    const operations = mergeOperations(operationsFromOpenApi(document), operationsFromCatalog(row));
    if (operations.length === 0) limitations.push("No operation schema was available; this service cannot be called automatically.");
    const profile: MppServiceProfile = {
      serviceId: stringValue(row.id) ?? serviceIdOrName,
      name: stringValue(row.name) ?? serviceIdOrName,
      description: stringValue(row.description) ?? "",
      baseUrl,
      categories: stringArray(row.categories),
      status: stringValue(row.status),
      operations,
      documentation: null,
      discoverySource: "catalog_fallback",
      limitations
    };
    return hydrateProfileFromOfficialDocumentation(profile, row, usageIntent, this.config, this.fetchImpl);
  }

  private async hydrateProfileDocumentation(
    profile: MppServiceProfile,
    serviceIdOrName: string,
    usageIntent?: string
  ): Promise<MppServiceProfile> {
    if (profile.operations.every((operation) => operation.requestShape !== null)) return profile;
    try {
      const requested = serviceIdOrName.toLowerCase();
      const row = (await this.catalogRows()).find((candidate) =>
        stringValue(candidate.id)?.toLowerCase() === requested ||
        stringValue(candidate.name)?.toLowerCase() === requested ||
        stringValue(candidate.id)?.toLowerCase() === profile.serviceId.toLowerCase()
      );
      return row
        ? await hydrateProfileFromOfficialDocumentation(profile, row, usageIntent, this.config, this.fetchImpl)
        : profile;
    } catch {
      return profile;
    }
  }

  private async catalogRows(): Promise<Record<string, unknown>[]> {
    const url = await assertPublicHttpsUrl(this.config.serviceCatalogUrl);
    const response = await safeFetch(url, {}, { allowedOrigin: url.origin, fetchImpl: this.fetchImpl });
    if (!response.ok) throw new Error(`MPP catalog returned HTTP ${response.status}`);
    const value = await readBoundedJson(response, 2_000_000);
    if (Array.isArray(value)) return value.filter(isRecord);
    if (!isRecord(value)) return [];
    for (const key of ["services", "items", "data", "results"]) {
      if (Array.isArray(value[key])) return value[key].filter(isRecord);
    }
    return [];
  }
}

function normalizeRecommendations(value: Record<string, unknown>, limit: number): MppRecommendation[] {
  const recommendations = Array.isArray(value.recommendations)
    ? value.recommendations
    : Array.isArray(value.services)
      ? value.services.map((service) => ({ service }))
      : [];
  return recommendations.filter(isRecord).slice(0, limit).flatMap((item) => {
    const service = isRecord(item.service) ? item.service : item;
    const baseUrl = serviceBaseUrl(service);
    const serviceId = stringValue(service.id);
    if (!baseUrl || !serviceId) return [];
    const topOffers = Array.isArray(item.topOffers) ? item.topOffers.filter(isRecord).slice(0, 5) : [];
    return [{
      serviceId,
      name: stringValue(service.name) ?? serviceId,
      description: stringValue(service.description) ?? "",
      baseUrl,
      categories: stringArray(service.categories),
      status: stringValue(service.status),
      score: numberValue(item.score),
      reasons: stringArray(item.reasons),
      topOffers: topOffers.map((offer) => ({
        method: (stringValue(offer.method) ?? "GET").toUpperCase(),
        path: stringValue(offer.path) ?? "/",
        summary: stringValue(offer.description),
        price: offerPrice(isRecord(offer.price) ? offer.price : isRecord(offer.payment) ? offer.payment : {})
      }))
    }];
  });
}

function profileFromMcp(
  requested: string,
  recipe: Record<string, unknown>,
  openapiResult: Record<string, unknown>
): MppServiceProfile {
  const service = isRecord(recipe.service)
    ? recipe.service
    : isRecord(openapiResult.service)
      ? openapiResult.service
      : {};
  const baseUrl = stringValue(recipe.baseUrl) ?? serviceBaseUrl(service);
  if (!baseUrl) throw new Error(`Services MCP did not return a callable URL for ${requested}`);
  const openapi = isRecord(openapiResult.openapi) ? openapiResult.openapi : {};
  const document = isRecord(openapi.document) ? openapi.document : null;
  const registryOperations = operationsFromRegistryOpenApi(openapi);
  const recipeOperations = operationsFromRecipe(recipe);
  const operations = mergeOperations(operationsFromOpenApi(document), registryOperations, recipeOperations);
  const limitations: string[] = [];
  if (!document) limitations.push(MCP_REGISTRY_SUMMARY_LIMITATION);
  if (operations.length === 0) limitations.push("No operation schema was available; this service cannot be called automatically.");
  return {
    serviceId: stringValue(service.id) ?? requested,
    name: stringValue(service.name) ?? requested,
    description: stringValue(service.description) ?? "",
    baseUrl,
    categories: stringArray(service.categories),
    status: stringValue(service.status),
    operations,
    documentation: null,
    discoverySource: "services_mcp",
    limitations
  };
}

export async function hydrateProfileFromOfficialDocumentation(
  profile: MppServiceProfile,
  catalogRow: Record<string, unknown>,
  usageIntent: string | undefined,
  config: Pick<AppConfig["payments"]["mpp"], "maxResponseBytes">,
  fetchImpl: typeof fetch = fetch
): Promise<MppServiceProfile> {
  if (profile.documentation || profile.operations.every((operation) => operation.requestShape !== null)) return profile;
  const index = await firstAvailableDocumentationIndex(catalogRow, config, fetchImpl);
  if (!index) return profile;
  const references = documentationReferences(index.content, index.url);
  const selected = references
    .map((reference, position) => ({
      ...reference,
      position,
      score: documentationReferenceScore(reference, profile, usageIntent)
    }))
    .filter((reference) => reference.score > 0)
    .sort((left, right) => right.score - left.score || left.position - right.position)[0];
  if (!selected) return profile;
  try {
    const url = await assertPublicHttpsUrl(selected.url);
    const response = await safeFetch(url, {}, { allowedOrigin: url.origin, fetchImpl });
    if (!response.ok) return profile;
    const content = await readBoundedText(response, Math.min(config.maxResponseBytes, MAX_DOCUMENTATION_PAGE_BYTES));
    return {
      ...profile,
      documentation: {
        indexUrl: index.url.toString(),
        pageUrl: url.toString(),
        title: selected.title,
        excerpt: documentationExcerpt(content)
      }
    };
  } catch {
    return profile;
  }
}

export async function hydrateProfileFromAdvertisedOpenApi(
  profile: MppServiceProfile,
  config: Pick<AppConfig["payments"]["mpp"], "maxResponseBytes">,
  fetchImpl: typeof fetch = fetch
): Promise<MppServiceProfile> {
  if (!profile.limitations.includes(MCP_REGISTRY_SUMMARY_LIMITATION)) return profile;
  try {
    const base = await assertPublicHttpsUrl(profile.baseUrl);
    const openapiUrl = new URL("openapi.json", base.toString().endsWith("/") ? base : new URL(`${base.toString()}/`));
    const response = await safeFetch(openapiUrl, {}, { allowedOrigin: base.origin, fetchImpl });
    if (!response.ok) return profile;
    const document = await readBoundedJson(response, Math.min(config.maxResponseBytes, 1_000_000));
    const documentOperations = operationsFromOpenApi(document);
    if (documentOperations.length === 0) return profile;
    const operations = mergeOperations(documentOperations, profile.operations);
    const hasCompleteRequestShapes = operations.every((operation) => operation.requestShape !== null);
    return {
      ...profile,
      operations,
      limitations: hasCompleteRequestShapes
        ? profile.limitations.filter((limitation) => limitation !== MCP_REGISTRY_SUMMARY_LIMITATION)
        : profile.limitations
    };
  } catch {
    return profile;
  }
}

function operationsFromRegistryOpenApi(openapi: Record<string, unknown>): MppOperation[] {
  const endpoints = Array.isArray(openapi.endpoints)
    ? openapi.endpoints
    : Array.isArray(openapi.paths)
      ? openapi.paths
      : [];
  return operationsFromEndpointRows(endpoints);
}

function operationsFromRecipe(recipe: Record<string, unknown>): MppOperation[] {
  return operationsFromEndpointRows(Array.isArray(recipe.offers) ? recipe.offers : []);
}

function operationsFromCatalog(row: Record<string, unknown>): MppOperation[] {
  return operationsFromEndpointRows(Array.isArray(row.endpoints) ? row.endpoints : []);
}

function operationsFromEndpointRows(rows: unknown[]): MppOperation[] {
  return rows.filter(isRecord).flatMap((row) => {
    const path = stringValue(row.path);
    const method = stringValue(row.method)?.toUpperCase();
    if (!path || !method || !HTTP_METHODS.has(method)) return [];
    const payment = isRecord(row.payment) ? row.payment : {};
    return [{
      operationId: stringValue(row.operationId) ?? generatedOperationId(method, path),
      method,
      path,
      summary: stringValue(row.summary) ?? stringValue(row.description),
      requestShape: null,
      offers: paymentOfferList(payment)
    }];
  });
}

export function operationsFromOpenApi(value: unknown): MppOperation[] {
  if (!isRecord(value)) return [];
  const parsed = DiscoveryDocument.safeParse(value);
  const document = parsed.success ? parsed.data as unknown as Record<string, unknown> : value;
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: MppOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!isRecord(operation)) continue;
      const paymentInfo = isRecord(operation["x-payment-info"]) ? operation["x-payment-info"] : {};
      operations.push({
        operationId: stringValue(operation.operationId) ?? generatedOperationId(method, path),
        method,
        path,
        summary: stringValue(operation.summary) ?? stringValue(operation.description),
        requestShape: requestShape(operation),
        offers: paymentOfferList(paymentInfo)
      });
    }
  }
  return operations;
}

function paymentOfferList(value: Record<string, unknown>): MppPaymentOffer[] {
  const rows = Array.isArray(value.offers) ? value.offers.filter(isRecord) : Object.keys(value).length > 0 ? [value] : [];
  return rows.map((offer) => ({
    method: stringValue(offer.method),
    intent: stringValue(offer.intent),
    currency: stringValue(offer.currency),
    amount: stringValue(offer.amount),
    decimals: numberValue(offer.decimals),
    display: offerPrice(offer),
    unitType: stringValue(offer.unitType),
    dynamic: offer.amount == null || Boolean(offer.dynamic)
  }));
}

function requestShape(operation: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const parameters = Array.isArray(operation.parameters) ? operation.parameters.filter(isRecord) : [];
  for (const parameter of parameters.slice(0, 20)) {
    const name = stringValue(parameter.name);
    const location = stringValue(parameter.in);
    if (!name || !location) continue;
    const schema = isRecord(parameter.schema) ? parameter.schema : {};
    parts.push(`${location} ${name}:${schemaType(schema)}${parameter.required ? " required" : ""}`);
  }
  const requestBody = isRecord(operation.requestBody) ? operation.requestBody : null;
  const content = requestBody && isRecord(requestBody.content) ? requestBody.content : null;
  const json = content && (isRecord(content["application/json"]) ? content["application/json"] : firstRecordValue(content));
  const schema = isRecord(json) && isRecord(json.schema) ? json.schema : null;
  if (schema) parts.push(`JSON ${objectShape(schema)}${requestBody?.required ? " required" : ""}`);
  return parts.length > 0 ? parts.join("; ") : null;
}

function objectShape(schema: Record<string, unknown>, depth = 0): string {
  if (depth >= 2) return schemaType(schema);
  const properties = isRecord(schema.properties) ? schema.properties : null;
  if (!properties) return schemaType(schema);
  const required = new Set(stringArray(schema.required));
  const fields = Object.entries(properties).slice(0, 20).map(([name, field]) => {
    const type = isRecord(field) ? objectShape(field, depth + 1) : "unknown";
    return `${name}:${type}${required.has(name) ? "!" : ""}`;
  });
  return `{${fields.join(", ")}${Object.keys(properties).length > fields.length ? ", …" : ""}}`;
}

function schemaType(schema: Record<string, unknown>): string {
  const type = stringValue(schema.type);
  if (type === "array" && isRecord(schema.items)) return `${schemaType(schema.items)}[]`;
  if (type) return type;
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 5).map(String).join("|");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.filter(isRecord).slice(0, 5).map(schemaType).join("|") || "unknown";
  if (Array.isArray(schema.oneOf)) return schema.oneOf.filter(isRecord).slice(0, 5).map(schemaType).join("|") || "unknown";
  return isRecord(schema.properties) ? "object" : "unknown";
}

function mergeOperations(...groups: MppOperation[][]): MppOperation[] {
  const merged = new Map<string, MppOperation>();
  for (const operation of groups.flat()) {
    const key = `${operation.method} ${operation.path}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, operation);
      continue;
    }
    merged.set(key, {
      ...existing,
      operationId: existing.operationId || operation.operationId,
      summary: existing.summary ?? operation.summary,
      requestShape: existing.requestShape ?? operation.requestShape,
      offers: offerListScore(existing.offers) >= offerListScore(operation.offers) ? existing.offers : operation.offers
    });
  }
  return [...merged.values()].slice(0, 100);
}

function offerListScore(offers: MppPaymentOffer[]): number {
  return offers.reduce((best, offer) => Math.max(best,
    (offer.amount ? 4 : 0) +
    (offer.decimals != null ? 2 : 0) +
    (offer.currency ? 1 : 0) +
    (offer.method === "tempo" ? 1 : 0)
  ), 0);
}

function recommendationFromCatalog(row: Record<string, unknown>): MppRecommendation {
  const endpoints = operationsFromCatalog(row).slice(0, 5);
  return {
    serviceId: stringValue(row.id) ?? stringValue(row.name) ?? "unknown",
    name: stringValue(row.name) ?? stringValue(row.id) ?? "Unknown service",
    description: stringValue(row.description) ?? "",
    baseUrl: serviceBaseUrl(row) ?? "",
    categories: stringArray(row.categories),
    status: stringValue(row.status),
    score: null,
    reasons: [],
    topOffers: endpoints.map((operation) => ({
      method: operation.method,
      path: operation.path,
      summary: operation.summary,
      price: operation.offers[0]?.display ?? null
    }))
  };
}

function serviceBaseUrl(value: Record<string, unknown>): string | null {
  return stringValue(value.serviceUrl) ?? stringValue(value.service_url) ?? stringValue(value.baseUrl) ?? stringValue(value.base_url) ?? stringValue(value.endpoint) ?? stringValue(value.apiUrl) ?? stringValue(value.api_url) ?? stringValue(value.url);
}

function openApiUrl(value: Record<string, unknown>): string | null {
  const docs = isRecord(value.docs) ? value.docs : {};
  return stringValue(value.openapiUrl) ?? stringValue(value.openapi_url) ?? stringValue(value.discoveryUrl) ?? stringValue(docs.openapi) ?? stringValue(docs.openapiUrl) ?? stringValue(docs.apiReference);
}

async function firstAvailableDocumentationIndex(
  row: Record<string, unknown>,
  config: Pick<AppConfig["payments"]["mpp"], "maxResponseBytes">,
  fetchImpl: typeof fetch
): Promise<{ url: URL; content: string } | null> {
  const docs = isRecord(row.docs) ? row.docs : {};
  const configured = stringValue(docs.llmsTxt) ?? stringValue(docs.llms_txt) ?? stringValue(row.llmsTxt) ?? stringValue(row.llms_txt);
  const provider = stringValue(row.url);
  const candidates = new Set<string>();
  if (configured) candidates.add(configured);
  if (provider) {
    try {
      const base = new URL(provider);
      candidates.add(new URL("/llms.txt", base).toString());
      if (base.hostname.startsWith("api.")) {
        const docsHost = new URL(base);
        docsHost.hostname = `docs.${base.hostname.slice(4)}`;
        candidates.add(new URL("/llms.txt", docsHost).toString());
      }
    } catch {
      // Ignore malformed provider metadata and leave the profile unhydrated.
    }
  }
  for (const candidate of candidates) {
    try {
      const url = await assertPublicHttpsUrl(candidate);
      const response = await safeFetch(url, {}, { allowedOrigin: url.origin, fetchImpl });
      if (!response.ok) continue;
      const content = await readBoundedText(response, Math.min(config.maxResponseBytes, MAX_DOCUMENTATION_INDEX_BYTES));
      if (content.trim()) return { url, content };
    } catch {
      // Documentation is optional. Continue through the bounded candidate list.
    }
  }
  return null;
}

type DocumentationReference = { title: string; description: string; url: string };

function documentationReferences(content: string, indexUrl: URL): DocumentationReference[] {
  const references: DocumentationReference[] = [];
  const pattern = /^\s*[-*]?\s*\[([^\]]+)]\(([^)]+)\)\s*:?[ \t]*(.*)$/gm;
  for (const match of content.matchAll(pattern)) {
    const title = match[1]?.trim();
    const href = match[2]?.trim();
    if (!title || !href) continue;
    try {
      const url = new URL(href, indexUrl);
      if (url.protocol !== "https:") continue;
      references.push({ title, description: match[3]?.trim() ?? "", url: url.toString() });
    } catch {
      // Ignore malformed links in untrusted provider documentation.
    }
  }
  return references.slice(0, 500);
}

function documentationReferenceScore(
  reference: DocumentationReference,
  profile: MppServiceProfile,
  usageIntent?: string
): number {
  const terms = significantTerms([
    profile.name,
    profile.description,
    ...profile.categories,
    ...profile.operations.flatMap((operation) => [operation.operationId, operation.path, operation.summary ?? ""]),
    usageIntent ?? ""
  ].join(" "));
  const haystack = `${reference.title} ${reference.description} ${reference.url}`.toLowerCase();
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += term.length >= 8 ? 3 : 1;
  if (/\b(api|reference|usage|getting started)\b/i.test(reference.title)) score += 1;
  if (/\b(cheapest|lowest|flexible|season|spring|summer|fall|autumn|winter)\b/i.test(usageIntent ?? "") && /\b(deals?|prices?)\b/i.test(haystack)) score += 8;
  return score;
}

function significantTerms(value: string): Set<string> {
  return new Set(
    value.toLowerCase().split(/[^a-z0-9]+/).filter((term) =>
      term.length >= 4 && !DOCUMENTATION_STOP_WORDS.has(term)
    )
  );
}

function documentationExcerpt(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (Buffer.byteLength(normalized) <= MAX_DOCUMENTATION_EXCERPT_BYTES) return normalized;
  let excerpt = normalized.slice(0, MAX_DOCUMENTATION_EXCERPT_BYTES);
  while (Buffer.byteLength(excerpt) > MAX_DOCUMENTATION_EXCERPT_BYTES) excerpt = excerpt.slice(0, -256);
  const lastLine = excerpt.lastIndexOf("\n");
  if (lastLine > MAX_DOCUMENTATION_EXCERPT_BYTES / 2) excerpt = excerpt.slice(0, lastLine);
  return `${excerpt}\n… [official documentation excerpt truncated]`;
}

function offerPrice(value: Record<string, unknown>): string | null {
  const display = stringValue(value.display) ?? stringValue(value.amountHint);
  if (display) return display;
  const amount = stringValue(value.amount);
  const decimals = numberValue(value.decimals);
  if (!amount) return value.dynamic ? "dynamic" : null;
  if (decimals != null && /^\d+$/.test(amount)) {
    const padded = amount.padStart(decimals + 1, "0");
    const whole = decimals === 0 ? padded : padded.slice(0, -decimals);
    const fraction = decimals === 0 ? "" : padded.slice(-decimals).replace(/0+$/, "");
    return `${whole}${fraction ? `.${fraction}` : ""} ${stringValue(value.currency) ?? "base units"}`;
  }
  return `${amount} ${stringValue(value.currency) ?? "base units"}`;
}

function generatedOperationId(method: string, path: string): string {
  return `${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "root"}`;
}

function normalizedCategory(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && MPP_CATEGORIES.has(normalized) ? normalized : undefined;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`MPP discovery response exceeds ${maxBytes} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`MPP discovery response exceeds ${maxBytes} bytes`);
  return JSON.parse(bytes.toString("utf8"));
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`MPP documentation response exceeds ${maxBytes} bytes`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error(`MPP documentation response exceeds ${maxBytes} bytes`);
  return bytes.toString("utf8");
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""));
}

function textContent(content: unknown[]): string {
  return content.filter(isRecord).filter((item) => item.type === "text").map((item) => stringValue(item.text) ?? "").filter(Boolean).join("\n");
}

function firstRecordValue(value: Record<string, unknown>): Record<string, unknown> | null {
  return Object.values(value).find(isRecord) ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MPP_CATEGORIES = new Set(["ai", "blockchain", "compute", "data", "media", "search", "social", "storage", "web"]);
const MCP_REGISTRY_SUMMARY_LIMITATION = "The directory returned a registry summary rather than a full OpenAPI document; request fields may be incomplete.";
const MAX_DOCUMENTATION_INDEX_BYTES = 128_000;
const MAX_DOCUMENTATION_PAGE_BYTES = 128_000;
const MAX_DOCUMENTATION_EXCERPT_BYTES = 8_500;
const DOCUMENTATION_STOP_WORDS = new Set([
  "about", "after", "before", "between", "call", "from", "into", "operation", "prices", "request", "search", "service", "this", "with"
]);
