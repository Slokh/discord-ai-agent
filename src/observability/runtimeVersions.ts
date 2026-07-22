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

export function runtimeVersionMetadata(config?: AppConfig | null) {
  const openRouter = config?.openRouter;
  return {
    appRevision: config?.appRevision || "unknown",
    promptVersion,
    toolVersion,
    configVersion: hash(JSON.stringify(config && openRouter ? {
      chatModel: openRouter.chatModel,
      utilityModel: openRouter.utilityModel,
      embeddingModel: openRouter.embeddingModel,
      imageModel: openRouter.imageModel,
      transcriptionModel: openRouter.transcriptionModel,
      embeddingDimensions: config.embeddingDimensions,
      maxHistoryResults: config.maxHistoryResults,
      maxThreadSummaryMessages: config.maxThreadSummaryMessages,
      toolsetScoping: config.toolsetScoping,
      promptConcurrency: config.agentPromptMaxConcurrency,
      chatTimeouts: config.chatTimeouts,
    } : { config: "unknown" })),
  };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
