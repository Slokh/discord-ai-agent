import { recordAgentEvent } from "../agent/runtimeTranscript.js";
import type { MppCallInput } from "../payments/mppService.js";
import type { PaymentEventRecorder } from "../payments/types.js";
import { summarizeForAudit } from "../util/text.js";
import type { AgentResponse, ToolContext } from "./types.js";

export async function discoverMppServices(
  ctx: ToolContext,
  input: { query?: string; category?: string; limit?: number }
): Promise<string> {
  if (!ctx.mppService) return unavailable();
  const result = await ctx.mppService.discover(input, paymentRecorder(ctx));
  await audit(ctx, "discoverMppServices", input, result);
  return result;
}

export async function inspectMppService(ctx: ToolContext, serviceIdOrUrl?: string): Promise<string> {
  if (!ctx.mppService) return unavailable();
  const result = await ctx.mppService.inspect(serviceIdOrUrl, paymentRecorder(ctx));
  await audit(ctx, "inspectMppService", { serviceIdOrUrl }, result);
  return result;
}

export async function callMppService(ctx: ToolContext, input: MppCallInput): Promise<AgentResponse> {
  if (!ctx.mppService) return { content: unavailable(), status: "error", errorCode: "mpp_unavailable", retryable: false };
  try {
    const result = await ctx.mppService.call(
      {
        guildId: ctx.guildId,
        userId: ctx.userId,
        executionId: ctx.agentRuntimeExecutionId ?? ctx.requestId ?? null,
        requestText: ctx.requestText ?? null
      },
      input,
      paymentRecorder(ctx)
    );
    await audit(ctx, "callMppService", auditInput(input), result.content);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(ctx, "callMppService", auditInput(input), `failed: ${message}`);
    return { content: `MPP request was not completed: ${message}`, status: "error", errorCode: "mpp_request_failed", retryable: false };
  }
}

function paymentRecorder(ctx: ToolContext): PaymentEventRecorder {
  return async (event) => {
    await recordAgentEvent(ctx, {
      ...event,
      traceId: ctx.requestId,
      requestId: ctx.requestId,
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId,
      messageId: ctx.requestMessageId
    });
  };
}

async function audit(ctx: ToolContext, toolName: string, args: Record<string, unknown>, result: string): Promise<void> {
  await ctx.repo.auditTool({
    guildId: ctx.guildId,
    channelId: ctx.channelId,
    userId: ctx.userId,
    toolName,
    argumentsSummary: summarizeForAudit(args),
    resultSummary: summarizeForAudit(result)
  });
}

function auditInput(input: MppCallInput): Record<string, unknown> {
  return {
    inspectionId: input.inspectionId,
    operationId: input.operationId,
    pathParamKeys: Object.keys(input.pathParams ?? {}),
    queryKeys: Object.keys(input.query ?? {}),
    hasBody: input.body !== undefined,
    expectedResponseType: input.expectedResponseType,
    effect: input.effect,
    hasUserAuthorization: Boolean(input.userAuthorization),
    allowRepeat: Boolean(input.allowRepeat)
  };
}

function unavailable(): string {
  return "MPP paid-service access is not enabled in this deployment.";
}
