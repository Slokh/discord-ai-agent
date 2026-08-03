import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxEnv } from "./sandboxEnv.js";

/** Writes the intentionally small command surface exposed to the coding agent. */
export async function writeSandboxToolShims(
  toolShimDir: string,
  env: SandboxEnv,
): Promise<string[]> {
  await fs.mkdir(toolShimDir, { recursive: true });
  const shims = {
    "agent-task-context": [
      "#!/bin/sh",
      "printf '%s\\n' \"Task ID: $TASK_ID\" \"Trace ID: $TRACE_ID\" \"Requested by: $REQUESTED_BY\"",
      `printf '%s\\n' ${shellQuote(`Repository: ${env.githubRepository}`)} ${shellQuote(`Base branch: ${env.githubBaseBranch}`)} ${shellQuote(`Cache dir: ${env.sandboxCacheDir}`)}`,
      "",
    ].join("\n"),
    "agent-cache-info": [
      "#!/bin/sh",
      "set -eu",
      `cache_dir=${shellQuote(env.sandboxCacheDir)}`,
      "echo \"Cache dir: $cache_dir\"",
      "for name in repos npm node_modules locks; do",
      "  path=\"$cache_dir/$name\"",
      "  if [ -e \"$path\" ]; then",
      "    count=$(find \"$path\" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')",
      "    echo \"$name: $count entries\"",
      "  else",
      "    echo \"$name: missing\"",
      "  fi",
      "done",
      "",
    ].join("\n"),
    "agent-progress": [
      "#!/bin/sh",
      "set -eu",
      "step=${1:-codegen_note}",
      "if [ \"$#\" -gt 0 ]; then shift; fi",
      "message=${*:-Coding agent reported progress.}",
      "node -e '",
      "const [step, message] = process.argv.slice(1);",
      "const taskId = process.env.TASK_ID;",
      "const token = process.env.AGENT_TASK_TOKEN;",
      `const baseUrl = ${JSON.stringify(env.controlPlaneInternalUrl.replace(/\/$/, ""))};`,
      "if (!taskId || !token || !baseUrl) { console.error(\"Missing task callback environment.\"); process.exit(1); }",
      "const url = `${baseUrl}/internal/tasks/${encodeURIComponent(taskId)}/events`;",
      "const body = JSON.stringify({ step, message, metadata: { source: \"agent-progress\" } });",
      "fetch(url, { method: \"POST\", headers: { \"content-type\": \"application/json\", authorization: `Bearer ${token}` }, body })",
      "  .then(async (response) => { if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`); })",
      "  .catch((error) => { console.error(error); process.exit(1); });",
      "' \"$step\" \"$message\"",
      "",
    ].join("\n"),
  };
  await Promise.all(
    Object.entries(shims).map(async ([name, content]) => {
      await fs.writeFile(path.join(toolShimDir, name), content, {
        encoding: "utf8",
        mode: 0o755,
      });
    }),
  );
  return Object.keys(shims);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
