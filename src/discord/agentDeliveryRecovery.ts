import type { Logger } from "pino";
import type { AgentFile } from "../tools/types.js";
import type { DiscordAgentExecutionRequest, DiscordAgentRequestInput } from "./requestContext.js";
import {
  deliveryFileReference,
  DISCORD_DELIVERY_FILE_ARTIFACT_KIND,
  MAX_DURABLE_DELIVERY_FILE_BYTES,
  MAX_DURABLE_DELIVERY_TOTAL_BYTES,
  type DiscordDeliveryFileReference,
} from "./deliveryIntent.js";

export async function persistDeliveryFiles(input: {
  agentRuntime: NonNullable<DiscordAgentRequestInput["agentRuntime"]>;
  sessionId: string;
  executionId: string;
  files: AgentFile[];
}): Promise<DiscordDeliveryFileReference[]> {
  const totalBytes = input.files.reduce((sum, file) => sum + file.data.length, 0);
  const oversized = input.files.find((file) => file.data.length > MAX_DURABLE_DELIVERY_FILE_BYTES);
  if (oversized) throw new Error(`Discord delivery file ${oversized.name} exceeds the ${MAX_DURABLE_DELIVERY_FILE_BYTES}-byte durable recovery limit.`);
  if (totalBytes > MAX_DURABLE_DELIVERY_TOTAL_BYTES) throw new Error(`Discord delivery files exceed the ${MAX_DURABLE_DELIVERY_TOTAL_BYTES}-byte durable recovery limit.`);
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60_000);
  return Promise.all(input.files.map(async (file) => {
    const artifact = await input.agentRuntime.storeBinaryArtifact({
      sessionId: input.sessionId,
      executionId: input.executionId,
      kind: DISCORD_DELIVERY_FILE_ARTIFACT_KIND,
      name: file.name,
      data: file.data,
      contentType: file.contentType,
      expiresAt,
      metadata: { deliveryFile: true },
    });
    return deliveryFileReference({ artifactId: artifact.artifactId, file, sha256: String(artifact.metadata.sha256) });
  }));
}

export async function releaseFailedRequestWager(
  input: DiscordAgentRequestInput,
  request: DiscordAgentExecutionRequest,
  error: unknown,
  requestLogger: Logger,
) {
  const explanation = `Agent request failed before wager completion: ${error instanceof Error ? error.message : String(error)}`;
  await input.walletService?.releaseOpenWagerByRequestId(request.requestId, explanation).catch((releaseError) => requestLogger.error({ err: releaseError }, "Failed to release wager after agent request failure"));
}
