import type { AgentTaskProgressEvent } from "./types.js";

export type AgentTaskProgressReporter = (event: AgentTaskProgressEvent) => Promise<void> | void;

export async function reportAgentTaskProgress(reporter: AgentTaskProgressReporter | undefined, event: AgentTaskProgressEvent) {
  if (!reporter) return;
  await reporter(event);
}
