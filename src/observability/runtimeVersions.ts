import { createHash } from "node:crypto";
import type { AppConfig } from "../config/env.js";
import { chatMessages } from "../agent/promptBuilder.js";
import { toolRegistry } from "../tools/registry.js";

const promptVersion = hash(JSON.stringify(chatMessages("", "")[0]));
const toolVersion = hash(JSON.stringify(toolRegistry.map((tool) => ({
  name: tool.name,
  group: tool.group,
  mutates: tool.mutates,
  description: tool.description,
  parameters: tool.parameters,
}))));
export const QUALITY_RUNTIME_VERSION = "1";

export type QualityCohortIdentity = {
  qualityVersion: string;
  promptVersion: string;
  toolVersion: string;
  configVersion: string;
  qualityRuntimeVersion: string;
};

export function runtimeVersionMetadata(config?: AppConfig | null) {
  const openRouter = config?.openRouter;
  const configVersion = hash(JSON.stringify(config && openRouter ? {
    chatModel: openRouter.chatModel,
    utilityModel: openRouter.utilityModel,
    embeddingModel: openRouter.embeddingModel,
    imageModel: openRouter.imageModel,
    transcriptionModel: openRouter.transcriptionModel,
    embeddingDimensions: config.embeddingDimensions,
    maxHistoryResults: config.maxHistoryResults,
    maxThreadSummaryMessages: config.maxThreadSummaryMessages,
    promptConcurrency: config.agentPromptMaxConcurrency,
    chatTimeouts: config.chatTimeouts,
  } : { config: "unknown" }));
  const cohort = qualityCohortIdentity({
    promptVersion,
    toolVersion,
    configVersion,
    qualityRuntimeVersion: QUALITY_RUNTIME_VERSION,
  });
  return {
    appRevision: config?.appRevision || "unknown",
    ...cohort,
  };
}

export function qualityCohortIdentity(input: Omit<QualityCohortIdentity, "qualityVersion">): QualityCohortIdentity {
  return {
    ...input,
    qualityVersion: hash(JSON.stringify({
      schemaVersion: 1,
      promptVersion: input.promptVersion,
      toolVersion: input.toolVersion,
      configVersion: input.configVersion,
      qualityRuntimeVersion: input.qualityRuntimeVersion,
    })),
  };
}

export function qualityCohortIdentityFromMetadata(metadata: Record<string, unknown>): QualityCohortIdentity | null {
  const promptVersion = version(metadata.promptVersion);
  const toolVersion = version(metadata.toolVersion);
  const configVersion = version(metadata.configVersion);
  if (!promptVersion || !toolVersion || !configVersion) return null;
  return qualityCohortIdentity({
    promptVersion,
    toolVersion,
    configVersion,
    qualityRuntimeVersion: version(metadata.qualityRuntimeVersion) ?? QUALITY_RUNTIME_VERSION,
  });
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function version(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
