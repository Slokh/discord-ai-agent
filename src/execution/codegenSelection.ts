import type { AppConfig } from "../config/env.js";

export type CodegenExecutionSelection = {
  codegenBackend: AppConfig["execution"]["codegenBackend"];
  codegenModel: string;
  codegenProvider: string;
};

export function codegenExecutionSelection(config: AppConfig): CodegenExecutionSelection {
  return {
    codegenBackend: config.execution.codegenBackend,
    codegenModel: config.openRouter.codegenModel,
    codegenProvider: providerForCodegenModel(config.openRouter.codegenModel)
  };
}

export function providerForCodegenModel(model: string) {
  return model.includes("/") ? "openrouter" : "openai";
}
