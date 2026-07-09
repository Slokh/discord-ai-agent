import type { SandboxEnv } from "./sandboxEnv.js";

export async function progress(env: SandboxEnv, step: string, message: string, metadata: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event: "task.progress", taskId: env.taskId, step, message, metadata }));
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/events`, { step, message, metadata });
}

export async function complete(env: SandboxEnv, body: Record<string, unknown>) {
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {};
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/complete`, {
    ...body,
    metadata: { sandboxRunId: env.sandboxRunId, ...metadata }
  });
}

export async function postJson(env: SandboxEnv, pathName: string, body: Record<string, unknown>) {
  const response = await fetch(`${env.controlPlaneInternalUrl}${pathName}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.taskToken}`
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Control-plane callback failed (${response.status}): ${await response.text()}`);
  }
}

export async function recordCommand(
  env: SandboxEnv | undefined,
  body: {
    step: string;
    command: string;
    exitCode: number;
    outputTail: string;
    errorTail: string;
    durationMs: number;
    metadata?: Record<string, unknown>;
  }
) {
  if (!env) return;
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/commands`, {
    sandboxRunId: env.sandboxRunId,
    ...body
  }).catch((error) => {
    console.error("Failed to post sandbox command event", error);
  });
}

export type SandboxArtifactKind =
  | "prompt"
  | "command_log"
  | "diff"
  | "pr_body"
  | "model_transcript"
  | "tool_transcript"
  | "crawl_summary"
  | "embedding_summary"
  | "raw_json"
  | "response"
  | "diagnostic";

export async function recordArtifact(
  env: SandboxEnv | undefined,
  body: {
    kind: SandboxArtifactKind;
    name: string;
    content: string;
    contentType: string;
    metadata?: Record<string, unknown>;
  }
) {
  if (!env) return;
  await postJson(env, `/internal/tasks/${encodeURIComponent(env.taskId)}/artifacts`, body).catch((error) => {
    console.error("Failed to post sandbox artifact", error);
  });
}
