import type { AppConfig } from "../config/env.js";

export const CODEGEN_REASONING = "medium" as const;

export type CodegenExecutionSelection = {
  codegenBackend: "kubernetes-job";
  codegenModel: string;
  codegenProvider: string;
  codegenReasoningEffort: typeof CODEGEN_REASONING;
};

export function codegenExecutionSelection(config: AppConfig): CodegenExecutionSelection {
  return {
    codegenBackend: "kubernetes-job",
    codegenModel: config.openRouter.codegenModel,
    codegenProvider: providerForCodegenModel(config.openRouter.codegenModel),
    codegenReasoningEffort: CODEGEN_REASONING,
  };
}

export function providerForCodegenModel(model: string) {
  return model.includes("/") ? "openrouter" : "openai";
}
