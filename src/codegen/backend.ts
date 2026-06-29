import type { AppConfig } from "../config/env.js";
import { runAgentCodegenJob, type AgentCodegenJob, type AgentCodegenResult } from "./runner.js";
import { AppConfigCodegenCredentialProvider, type CodegenCredentialProvider } from "./credentials.js";
import type { CodegenProgressReporter } from "./progress.js";

export type CodegenExecutionContext = {
  progress?: CodegenProgressReporter;
};

export type CodegenExecutionBackend = {
  name: string;
  run: (job: AgentCodegenJob, context?: CodegenExecutionContext) => Promise<AgentCodegenResult>;
};

export class RailwayCodegenBackend implements CodegenExecutionBackend {
  readonly name = "railway-local-worker";

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: CodegenCredentialProvider = new AppConfigCodegenCredentialProvider(config)
  ) {}

  async run(job: AgentCodegenJob, context: CodegenExecutionContext = {}) {
    return await runAgentCodegenJob({
      config: this.config,
      job,
      credentials: this.credentials,
      progress: context.progress
    });
  }
}
