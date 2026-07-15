import { callMppService, discoverMppServices, inspectMppService } from "../tools/mppTools.js";
import { cleanResponse } from "../tools/responseFormatting.js";
import type { AgentResponse, ToolContext } from "../tools/types.js";
import type { AgentToolRoute } from "./routerShared.js";

export async function executeMppToolRoute(ctx: ToolContext, route: AgentToolRoute): Promise<AgentResponse | null> {
  if (route.name === "discoverMppServices") {
    return {
      content: cleanResponse(
        await discoverMppServices(ctx, {
          query: stringArgument(route.arguments, "query"),
          category: stringArgument(route.arguments, "category"),
          limit: numberArgument(route.arguments, "limit")
        }),
        ctx.config.maxReplyChars
      )
    };
  }
  if (route.name === "inspectMppService") {
    const serviceIdOrUrl = stringArgument(route.arguments, "serviceIdOrUrl");
    const usageIntent = stringArgument(route.arguments, "usageIntent");
    return {
      content: cleanResponse(
        await (usageIntent
          ? inspectMppService(ctx, serviceIdOrUrl, usageIntent)
          : inspectMppService(ctx, serviceIdOrUrl)),
        Math.max(ctx.config.maxReplyChars, 12_000)
      )
    };
  }
  if (route.name !== "callMppService") return null;
  const response = await callMppService(ctx, {
    inspectionId: stringArgument(route.arguments, "inspectionId"),
    operationId: stringArgument(route.arguments, "operationId"),
    pathParams: recordArgument(route.arguments, "pathParams"),
    query: recordArgument(route.arguments, "query"),
    body: route.arguments?.body,
    expectedResponseType: stringArgument(route.arguments, "expectedResponseType"),
    effect: stringArgument(route.arguments, "effect") as "read_only" | "external_side_effect" | undefined,
    userAuthorization: stringArgument(route.arguments, "userAuthorization"),
    allowRepeat: booleanArgument(route.arguments, "allowRepeat")
  });
  return { ...response, content: cleanResponse(response.content, Math.max(ctx.config.maxReplyChars, 12_000)) };
}

function stringArgument(args: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArgument(args: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = args?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function recordArgument(args: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = args?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function booleanArgument(args: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = args?.[key];
  return typeof value === "boolean" ? value : undefined;
}
