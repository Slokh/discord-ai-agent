import type { AppConfig } from "../config/env.js";
import { CODEGEN_REASONING } from "../agent/modelPolicy.js";

export type CodegenExecutionSelection = {
  codegenBackend: AppConfig["execution"]["codegenBackend"];
  codegenModel: string;
  codegenProvider: string;
  codegenReasoningEffort: typeof CODEGEN_REASONING;
};

export function codegenExecutionSelection(config: AppConfig): CodegenExecutionSelection {
  return {
    codegenBackend: config.execution.codegenBackend,
    codegenModel: config.openRouter.codegenModel,
    codegenProvider: providerForCodegenModel(config.openRouter.codegenModel),
    codegenReasoningEffort: CODEGEN_REASONING,
  };
}

export function providerForCodegenModel(model: string) {
  return model.includes("/") ? "openrouter" : "openai";
}
