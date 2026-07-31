import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { NanoCodexRuntimeResult, NanoCodexSessionSnapshot } from "./nanocodexRuntime.js";

export const NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND = "nanocodex_session_snapshot";

export async function loadNanoCodexSessionSnapshot(input: {
  agentRuntime: AgentRuntimeRepository;
  sessionId: string;
}): Promise<NanoCodexSessionSnapshot | undefined> {
  const artifact = await input.agentRuntime.getLatestBinaryArtifactForSession({
    sessionId: input.sessionId,
    kind: NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND,
  });
  if (!artifact) return undefined;
  const parsed = JSON.parse(artifact.data.toString("utf8")) as unknown;
  assertNanoCodexSessionSnapshot(parsed);
  return parsed;
}
export async function storeNanoCodexSessionSnapshot(input: {
  agentRuntime: AgentRuntimeRepository;
  sessionId: string;
  executionId: string;
  result: NanoCodexRuntimeResult;
}): Promise<void> {
  const { snapshot } = input.result;
  assertNanoCodexSessionSnapshot(snapshot);
  await input.agentRuntime.storeBinaryArtifact({
    sessionId: input.sessionId,
    executionId: input.executionId,
    kind: NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND,
    name: "NanoCodex retained session checkpoint",
    contentType: "application/json",
    data: Buffer.from(JSON.stringify(snapshot), "utf8"),
    metadata: {
      schemaVersion: snapshot.version,
      model: snapshot.model,
      lineageId: snapshot.lineage_id,
      promptCacheKey: snapshot.prompt_cache_key,
      sensitive: true,
      canonical: true,
    },
  });
}

export function assertNanoCodexSessionSnapshot(value: unknown): asserts value is NanoCodexSessionSnapshot {
  if (!value || typeof value !== "object") throw new Error("NanoCodex session snapshot must be an object");
  const snapshot = value as Partial<NanoCodexSessionSnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.model !== "string" ||
    typeof snapshot.lineage_id !== "string" ||
    typeof snapshot.prompt_cache_key !== "string" ||
    typeof snapshot.workspace !== "string" ||
    !snapshot.canonical_context ||
    typeof snapshot.canonical_context !== "object" ||
    !Array.isArray(snapshot.history)
  ) {
    throw new Error("NanoCodex session snapshot is malformed or unsupported");
  }
}
