import type { AppConfig } from "../config/env.js";
import { nanocodeHostEnvironment } from "../config/nanocodeHostEnvironment.js";
import { localToolDefinitionsForModel } from "../tools/registry.js";
import { deploymentToolset } from "../tools/toolScope.js";
import { NanocodeHost, type NanocodeHostClient, type NanocodeToolDefinition } from "./nanocodeHost.js";

let shared: NanocodeHost | undefined;

/**
 * The process-wide nanocode host. Its tool catalog is the deployment's full
 * application toolset, which is fixed for the life of the process.
 */
export function sharedNanocodeHost(config: AppConfig): NanocodeHostClient {
  const { env, apiBaseUrl } = nanocodeHostEnvironment(config);
  shared ??= new NanocodeHost({
    tools: sessionToolDefinitions(localToolDefinitionsForModel(deploymentToolset(config).localTools)),
    appTitle: config.openRouter.appTitle,
    appUrl: config.openRouter.httpReferer,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    env,
    expectDurable: env.NANOCODE_STORE !== "memory" && Boolean(env.DATABASE_URL),
  });
  return shared;
}

export async function stopSharedNanocodeHost(): Promise<void> {
  const host = shared;
  shared = undefined;
  await host?.stop();
}

export function sessionToolDefinitions(tools: ReturnType<typeof localToolDefinitionsForModel>): NanocodeToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description ?? "",
    strict: false,
    parameters: tool.function.parameters,
  }));
}
