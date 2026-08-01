import { createHash } from "node:crypto";
import type { AgentRuntimeRepository } from "../db/agentRuntimeRepository.js";
import type { FunctionToolDefinition } from "../models/openrouter.js";
import type { NanoCodexRuntimeResult, NanoCodexSessionSnapshot } from "./nanocodexRuntime.js";

export const NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND = "nanocodex_session_snapshot";

export type NanoCodexSessionResumeContract = {
  contractVersion: 2;
  model: string;
  instructionsHash: string;
  toolsHash: string;
};

/**
 * NanoCodex snapshots can only be resumed with the exact instructions and
 * tool definitions that created them. Keep that compatibility evidence in
 * artifact metadata without modifying the opaque snapshot itself.
 */
export function nanoCodexSessionResumeContract(input: {
  instructions: string;
  tools: FunctionToolDefinition[];
  model: string;
}): NanoCodexSessionResumeContract {
  return {
    contractVersion: 2,
    model: input.model,
    instructionsHash: sha256(input.instructions),
    toolsHash: sha256(JSON.stringify(input.tools)),
  };
}

export async function loadNanoCodexSessionSnapshot(input: {
  agentRuntime: AgentRuntimeRepository;
  sessionId: string;
  resumeContract?: NanoCodexSessionResumeContract;
}): Promise<NanoCodexSessionSnapshot | undefined> {
  const artifact = await input.agentRuntime.getLatestBinaryArtifactForSession({
    sessionId: input.sessionId,
    kind: NANOCODEX_SESSION_SNAPSHOT_ARTIFACT_KIND,
  });
  if (!artifact) return undefined;
  if (input.resumeContract && !sameResumeContract(artifact.metadata?.resumeContract, input.resumeContract)) return undefined;
  const parsed = JSON.parse(artifact.data.toString("utf8")) as unknown;
  assertNanoCodexSessionSnapshot(parsed);
  return parsed;
}
export async function storeNanoCodexSessionSnapshot(input: {
  agentRuntime: AgentRuntimeRepository;
  sessionId: string;
  executionId: string;
  result: NanoCodexRuntimeResult;
  resumeContract?: NanoCodexSessionResumeContract;
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
      ...(input.resumeContract ? { resumeContract: input.resumeContract } : {}),
      sensitive: true,
      canonical: true,
    },
  });
}

function sameResumeContract(value: unknown, expected: NanoCodexSessionResumeContract): boolean {
  if (!value || typeof value !== "object") return false;
  const contract = value as Partial<NanoCodexSessionResumeContract>;
  return contract.contractVersion === expected.contractVersion &&
    contract.model === expected.model &&
    contract.instructionsHash === expected.instructionsHash &&
    contract.toolsHash === expected.toolsHash;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
