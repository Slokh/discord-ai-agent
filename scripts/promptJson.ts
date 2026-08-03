export type PromptJsonOutput = {
  runId?: string;
  traceId?: string;
  guildId?: string;
  channelId?: string;
  channelName?: string | null;
  visibleChannelCount?: number;
  threadKey?: string | null;
  durationMs?: number;
  content: string;
  files?: Array<{ name: string; contentType?: string; bytes: number; path: string }>;
};

/**
 * Reads the prompt CLI's structured result even when a dependency writes
 * unrelated JSON logs to stdout before or after it.
 */
export function extractPromptJson(stdout: string): PromptJsonOutput {
  for (const candidate of jsonObjects(stdout)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isPromptJsonOutput(parsed)) return parsed;
    } catch {
      // A balanced brace range can still be ordinary log text. Keep scanning.
    }
  }
  throw new Error("No complete prompt JSON result found in stdout.");
}

function jsonObjects(input: string) {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      quoted = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      objects.push(input.slice(start, index + 1));
      start = -1;
    }
  }
  return objects;
}

function isPromptJsonOutput(value: unknown): value is PromptJsonOutput {
  return typeof value === "object" && value != null && typeof (value as Record<string, unknown>).content === "string";
}
