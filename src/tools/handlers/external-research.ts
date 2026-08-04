import { runObservedModelCall } from "../../agent/modelCallTelemetry.js";
import { summarizeForAudit } from "../../util/text.js";
import { openRouterServerToolDefinitionsForModel } from "../registry.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";
import type { ToolContext } from "../types.js";

export const externalResearchToolHandlers = {
  web__run: async (ctx, route, _originalText) => {
    const operations = Array.isArray(route.arguments?.operations) ? route.arguments.operations : [];
    const commands = JSON.stringify(toHostedOperations(operations));
    const hostedTools = hostedToolsForOperations(operations);
    let response;
    try {
      response = await runObservedModelCall(ctx, {
        purpose: "external_web_research",
        chat: {
          model: ctx.config.openRouter.utilityModel,
          messages: [
            {
              role: "system",
              content:
                "Execute each supplied public-web operation exactly once with the matching hosted tool. Return only concise evidence produced for those operations; do not answer, mention, or infer any other part of the outer request. Include source URLs when the provider exposes them. State limitations instead of inventing facts.",
            },
            {
              role: "user",
              content: `Authoritative web operations:\n${commands}`,
            },
          ],
          tools: hostedTools,
          // The outer agent has already selected and validated a concrete web
          // operation. Requiring hosted execution avoids paying for a nested
          // model completion that merely paraphrases the request without data.
          toolChoice: "required",
          maxTokens: 1_200,
          reasoningEffort: "none",
          retryPolicy: "cheap",
        },
        metadata: { operationNames: operationKinds(operations) },
      });
    } catch {
      await auditWebResearch(ctx, operations, { error: "hosted_web_research_failed" });
      return evidenceFailure("Hosted web research failed before returning current external evidence.");
    }
    const hostedUse = Object.values(response.serverToolUse ?? {}).some((count) => count > 0);
    if (!hostedUse) {
      await auditWebResearch(ctx, operations, { error: "hosted_web_research_returned_no_tool_evidence" });
      return evidenceFailure("Hosted web research returned no current external evidence.");
    }
    if (!response.content.trim()) {
      await auditWebResearch(ctx, operations, { error: "hosted_web_research_returned_empty_content" });
      return evidenceFailure("Hosted web research completed without a readable result.");
    }
    const citations = uniqueSourceUrls(response.urlCitations?.map((citation) => citation.url) ?? []);
    await auditWebResearch(ctx, operations, {
      model: response.model,
      estimatedCostUsd: response.estimatedCostUsd ?? undefined,
      resultSummary: summarizeForAudit({
        operationNames: operationKinds(operations),
        citationCount: citations.length,
        outputChars: response.content.trim().length,
      }),
    });
    return {
      content: [response.content.trim(), citations.length ? `Sources:\n${citations.map((url) => `- ${url}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

async function auditWebResearch(
  ctx: ToolContext,
  operations: unknown[],
  result: { resultSummary?: string; error?: string; model?: string; estimatedCostUsd?: number },
) {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName: "web__run",
    argumentsSummary: summarizeForAudit({ operations }),
    resultSummary: result.resultSummary,
    error: result.error,
    model: result.model,
    estimatedCostUsd: result.estimatedCostUsd,
  });
}

function hostedToolsForOperations(operations: unknown[]) {
  const requestedTypes = new Set<string>();
  for (const operation of operations) {
    const kind = objectValue(operation).kind;
    if (kind === "search") requestedTypes.add("openrouter:web_search");
    if (kind === "open") requestedTypes.add("openrouter:web_fetch");
    if (kind === "time") requestedTypes.add("openrouter:datetime");
  }
  return openRouterServerToolDefinitionsForModel().filter((tool) => requestedTypes.has(tool.type));
}

function toHostedOperations(operations: unknown[]) {
  const search_query: Record<string, unknown>[] = [];
  const open: Record<string, unknown>[] = [];
  const time: Record<string, unknown>[] = [];
  for (const value of operations) {
    const operation = objectValue(value);
    if (operation.kind === "search") search_query.push(compact({ q: operation.query, recency: operation.recency, domains: operation.domains }));
    if (operation.kind === "open") open.push(compact({ ref_id: operation.refId, lineno: operation.lineno }));
    if (operation.kind === "time") time.push({ utc_offset: operation.utcOffset });
  }
  return compact({ search_query: search_query.length ? search_query : undefined, open: open.length ? open : undefined, time: time.length ? time : undefined });
}

function operationKinds(operations: unknown[]) {
  return [...new Set(operations.map((value) => String(objectValue(value).kind ?? "unknown")))].sort();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function uniqueSourceUrls(urls: string[]) {
  return [...new Set(urls.filter((url) => /^https?:\/\//.test(url)))];
}

function evidenceFailure(message: string) {
  return {
    content: `${message} Tell the user the lookup could not be verified and do not answer from memory.`,
    status: "error" as const,
    errorCode: "external_evidence_missing",
    retryable: true,
  };
}
