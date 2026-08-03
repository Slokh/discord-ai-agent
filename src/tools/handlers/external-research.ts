import { runObservedModelCall } from "../../agent/modelCallTelemetry.js";
import { openRouterServerToolDefinitionsForModel } from "../registry.js";
import type { ToolName } from "../toolDefinition.js";
import { stringArgument, stringArrayArgument } from "./arguments.js";
import type { LocalToolHandler } from "./types.js";

export const externalResearchToolHandlers = {
  researchWeb: async (ctx, route, _originalText) => {
    const question = stringArgument(route.arguments, "question")!;
    const urls = stringArrayArgument(route.arguments, "urls") ?? [];
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
                "Research the user's public-web question with the available hosted tools. Return concise grounded findings. Include the source URLs in the answer when the provider exposes them. State limitations instead of inventing facts.",
            },
            {
              role: "user",
              content: [
                `Question: ${question}`,
                urls.length ? `URLs to inspect:\n${urls.join("\n")}` : "",
              ].filter(Boolean).join("\n\n"),
            },
          ],
          tools: openRouterServerToolDefinitionsForModel(),
          maxTokens: 1_200,
          reasoningEffort: "low",
          retryPolicy: "cheap",
        },
        metadata: { requestedUrlCount: urls.length },
      });
    } catch {
      return evidenceFailure("Hosted web research failed before returning current external evidence.");
    }
    const hostedUse = Object.values(response.serverToolUse ?? {}).some((count) => count > 0);
    if (!hostedUse) {
      return evidenceFailure("Hosted web research returned no current external evidence.");
    }
    const citations = uniqueSourceUrls(response.urlCitations?.map((citation) => citation.url) ?? []);
    return {
      content: [response.content.trim(), citations.length ? `Sources:\n${citations.map((url) => `- ${url}`).join("\n")}` : ""]
        .filter(Boolean)
        .join("\n\n"),
    };
  },
} satisfies Partial<Record<ToolName, LocalToolHandler>>;

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
