import { collectAgentTaskStatusSnapshot } from "../observability/agentTaskStatus.js";
import { buildRunListAggregate } from "../observability/runAggregates.js";
import { listRunSummaries } from "../observability/runs.js";
import { authorizedUi } from "./internalApiAuth.js";
import { sendJson } from "./internalApiHttp.js";
import { parseBoolean, parseLimit, parseStaleAfterMs } from "./internalApiParsers.js";
import type { InternalApiInput } from "./internalApiTypes.js";

export async function handleInternalOperatorRoute(input: InternalApiInput, method: string, url: URL): Promise<boolean> {
  if (method === "GET" && url.pathname === "/api/runs") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw ? new Date(sinceRaw) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      sendJson(input.response, 400, { error: "invalid_since" });
      return true;
    }
    const runs = await listRunSummaries(input.repo, {
      limit: parseLimit(url.searchParams.get("limit"), 100, 200),
      includeEmbeddings: parseBoolean(url.searchParams.get("includeEmbeddings")),
      kind: url.searchParams.get("kind") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      channelId: url.searchParams.get("channelId") ?? undefined,
      revision: url.searchParams.get("revision") ?? undefined,
      since,
    });
    sendJson(input.response, 200, { runs, aggregate: buildRunListAggregate(runs), generatedAt: new Date().toISOString() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/payments") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    if (!input.paymentRepo) {
      sendJson(input.response, 503, { error: "payment_repository_unavailable" });
      return true;
    }
    const snapshot = await input.paymentRepo.getPaymentsConsoleSnapshot({
      guildId: url.searchParams.get("guildId") ?? undefined,
      limit: parseLimit(url.searchParams.get("limit"), 100, 500),
    });
    sendJson(input.response, 200, snapshot);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/tasks/status") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    if (!input.db) {
      sendJson(input.response, 503, { error: "database_unavailable" });
      return true;
    }
    sendJson(input.response, 200, (await collectAgentTaskStatusSnapshot(input.db, {
      limit: parseLimit(url.searchParams.get("limit"), 10, 100),
      staleAfterMs: parseStaleAfterMs(url.searchParams.get("staleMinutes")),
    })) as unknown as Record<string, unknown>);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/bugs/status") {
    if (!authorizedUi(input.config, input.request, input.response, url)) return true;
    const requesterUserId = url.searchParams.get("requesterUserId")?.trim();
    if (!requesterUserId || !/^\d{10,}$/.test(requesterUserId)) {
      sendJson(input.response, 400, { error: "invalid_requester_user_id" });
      return true;
    }
    const items = await input.repo.listDiscordBugInboxStatus({
      guildId: input.config.discord.guildId,
      requesterUserId,
      limit: parseLimit(url.searchParams.get("limit"), 20, 100),
    });
    sendJson(input.response, 200, {
      generatedAt: new Date().toISOString(), requesterUserId, items,
      counts: {
        total: items.length,
        awaitingValidation: items.filter((item) => ["marked", "pending", "queued", "running"].includes(item.validationStatus)).length,
        awaitingDeployment: items.filter((item) => item.disposition === "confirmed_fixed" && !item.deployedRevision).length,
        retryFailed: items.filter((item) => item.retryStatus === "failed").length,
      },
    });
    return true;
  }
  return false;
}
