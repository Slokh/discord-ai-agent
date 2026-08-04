import { runObservedModelCall } from "../../agent/modelCallTelemetry.js";
import { openRouterServerToolDefinitionsForModel } from "../registry.js";
import type { ToolName } from "../toolDefinition.js";
import type { LocalToolHandler } from "./types.js";

export const externalResearchToolHandlers = {
  web__run: async (ctx, route, _originalText) => {
    const operations = route.arguments ?? {};
    const commands = JSON.stringify(operations);
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
        metadata: { operationNames: Object.keys(operations).sort() },
      });
    } catch {
      return evidenceFailure("Hosted web research failed before returning current external evidence.");
    }
    const hostedUse = Object.values(response.serverToolUse ?? {}).some((count) => count > 0);
    if (!hostedUse) {
      return evidenceFailure("Hosted web research returned no current external evidence.");
    }
    if (!response.content.trim()) {
      return evidenceFailure("Hosted web research completed without a readable result.");
    }
    const citations = uniqueSourceUrls(response.urlCitations?.map((citation) => citation.url) ?? []);
    return {
      content: [response.content.trim(), citations.length ? `Sources:\n${citations.map((url) => `- ${url}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

function hostedToolsForOperations(operations: Record<string, unknown>) {
  const requestedTypes = new Set<string>();
  if (operations.search_query != null) requestedTypes.add("openrouter:web_search");
  if (operations.open != null) requestedTypes.add("openrouter:web_fetch");
  if (operations.time != null) requestedTypes.add("openrouter:datetime");
  return openRouterServerToolDefinitionsForModel().filter((tool) => requestedTypes.has(tool.type));
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
