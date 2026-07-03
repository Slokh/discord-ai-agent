type CodexTranscriptItemKind = "message" | "command" | "warning" | "error" | "lifecycle" | "tokens" | "reasoning";

type CodexCommandStart = {
  timestamp: string;
  command: string | null;
  summary: string;
};

export type ParsedCodexTranscript = {
  isTranscript: boolean;
  launchCommand: string | null;
  agentMessages: number;
  commands: number;
  reasoningDeltaCount: number;
  reasoningChars: number;
  tokenTotal: number | null;
  items: Array<{
    id: string;
    kind: CodexTranscriptItemKind;
    title: string;
    timestamp: string;
    body: string;
    command: string;
    output: string;
  }>;
};

export function parseCodexTranscript(content: string): ParsedCodexTranscript {
  const lines = content.split(/\r?\n/);
  const launchCommand = lines.find((line) => line.startsWith("$ "))?.slice(2).trim() || null;
  const records = lines.flatMap(parseCodexTranscriptRecord);
  const items: ParsedCodexTranscript["items"] = [];
  const commandStarts = new Map<string, CodexCommandStart>();
  let agentMessages = 0;
  let commands = 0;
  let reasoningDeltaCount = 0;
  let reasoningChars = 0;
  let tokenTotal: number | null = null;
  let tokenCached: number | null = null;
  let tokenOutput: number | null = null;

  if (launchCommand) {
    items.push({
      id: "launch-command",
      kind: "lifecycle",
      title: "App-server launched",
      timestamp: records[0]?.timestamp ?? new Date(0).toISOString(),
      body: "",
      command: launchCommand,
      output: ""
    });
  }

  for (const record of records) {
    const params = parseParamsPreview(record.metadata.paramsPreview);
    const item = objectValue(params?.item);
    const itemType = stringValue(record.metadata.itemType) ?? stringValue(item?.type);

    if (record.method === "warning") {
      items.push(transcriptItem(record, "warning", "Warning", stringValue(params?.message) ?? record.message));
      continue;
    }
    if (record.method === "thread/started") {
      const thread = objectValue(params?.thread);
      const modelProvider = stringValue(thread?.modelProvider);
      const cwd = stringValue(thread?.cwd);
      items.push(transcriptItem(record, "lifecycle", "Thread started", [modelProvider ? `Provider: ${modelProvider}` : "", cwd ? `cwd: ${cwd}` : ""].filter(Boolean).join("\n")));
      continue;
    }
    if (record.method === "turn/started") {
      items.push(transcriptItem(record, "lifecycle", "Turn started", ""));
      continue;
    }
    if (record.method === "thread/tokenUsage/updated") {
      const total = objectValue(objectValue(params?.tokenUsage)?.total);
      tokenTotal = numericValue(total?.totalTokens) ?? tokenTotal;
      tokenCached = numericValue(total?.cachedInputTokens) ?? tokenCached;
      tokenOutput = numericValue(total?.outputTokens) ?? tokenOutput;
      continue;
    }
    if (record.method === "item/reasoning/textDelta") {
      reasoningDeltaCount += 1;
      reasoningChars += stringValue(params?.delta)?.length ?? 0;
      continue;
    }
    if (record.method !== "item/completed" && record.method !== "item/started") continue;
    if (record.method === "item/started" && itemType !== "commandExecution") continue;

    if (itemType === "commandExecution" && record.method === "item/started") {
      const itemId = commandItemId(record, item);
      if (!itemId) continue;
      commandStarts.set(itemId, {
        timestamp: record.timestamp,
        command: stringValue(item?.command) ?? paramsPreviewStringField(record.metadata.paramsPreview, "command"),
        summary: commandActionSummary(item?.commandActions)
      });
      continue;
    }

    if (itemType === "agentMessage" && record.method === "item/completed") {
      const text = stringValue(item?.text);
      if (!text) continue;
      agentMessages += 1;
      items.push(transcriptItem(record, "message", `Assistant message ${agentMessages}`, text));
      continue;
    }
    if (itemType === "commandExecution" && record.method === "item/completed") {
      const commandStart = commandStarts.get(commandItemId(record, item) ?? "");
      const command = stringValue(item?.command) ?? paramsPreviewStringField(record.metadata.paramsPreview, "command") ?? commandStart?.command;
      if (!command) continue;
      commands += 1;
      const status = stringValue(item?.status) ?? paramsPreviewStringField(record.metadata.paramsPreview, "status");
      const durationMs = numericValue(item?.durationMs) ?? paramsPreviewNumberField(record.metadata.paramsPreview, "durationMs") ?? commandDurationFromTimestamps(commandStart?.timestamp, record.timestamp);
      const exitCode = numericValue(item?.exitCode) ?? paramsPreviewNumberField(record.metadata.paramsPreview, "exitCode");
      const actionSummary = commandActionSummary(item?.commandActions) || commandStart?.summary || "";
      const body = [
        status ? `Status: ${status}` : "",
        exitCode != null ? `Exit: ${exitCode}` : "",
        durationMs != null ? `Duration: ${formatDuration(durationMs)}` : "",
        actionSummary
      ]
        .filter(Boolean)
        .join(" · ");
      items.push({
        ...transcriptItem(record, "command", `Command ${commands}`, body),
        command,
        output: stringValue(item?.aggregatedOutput) ?? paramsPreviewStringField(record.metadata.paramsPreview, "aggregatedOutput", { allowTruncated: true }) ?? ""
      });
    }
  }

  if (reasoningDeltaCount > 0) {
    const firstRecord = records.find((record) => record.method === "item/reasoning/textDelta") ?? records[0];
    if (firstRecord) {
      items.push(
        transcriptItem(
          firstRecord,
          "reasoning",
          "Reasoning stream",
          `${reasoningDeltaCount.toLocaleString()} streamed chunks, ${reasoningChars.toLocaleString()} chars. Content is summarized here because the raw stream is noisy and token-level.`
        )
      );
    }
  }

  const stderr = transcriptSection(content, "stderr:");
  if (stderr) {
    const timestamp = records.at(-1)?.timestamp ?? new Date(0).toISOString();
    items.push({ id: "stderr", kind: "error", title: "Codex stderr", timestamp, body: "Process stderr captured before exit; this is not necessarily the stop reason.", command: "", output: stderr });
  }
  const terminalError = transcriptSection(content, "error:");
  if (terminalError) {
    const timestamp = records.at(-1)?.timestamp ?? new Date(0).toISOString();
    items.push({ id: "terminal-error", kind: "error", title: "App-server closed", timestamp, body: terminalError, command: "", output: "" });
  }
  if (tokenTotal != null) {
    const timestamp = records.at(-1)?.timestamp ?? new Date(0).toISOString();
    items.push({
      id: "token-usage",
      kind: "tokens",
      title: "Final token usage",
      timestamp,
      body: [
        `Total: ${tokenTotal.toLocaleString()}`,
        tokenCached != null ? `Cached input: ${tokenCached.toLocaleString()}` : "",
        tokenOutput != null ? `Output: ${tokenOutput.toLocaleString()}` : ""
      ]
        .filter(Boolean)
        .join(" · "),
      command: "",
      output: ""
    });
  }

  return {
    isTranscript: launchCommand != null && records.length > 0,
    launchCommand,
    agentMessages,
    commands,
    reasoningDeltaCount,
    reasoningChars,
    tokenTotal,
    items: items.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime())
  };
}

function parseCodexTranscriptRecord(line: string) {
  if (!line.startsWith("{")) return [];
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const timestamp = stringValue(parsed.timestamp);
    const method = stringValue(parsed.method);
    if (!timestamp || !method) return [];
    return [
      {
        timestamp,
        method,
        message: stringValue(parsed.message) ?? method,
        metadata: objectValue(parsed.metadata) ?? {}
      }
    ];
  } catch {
    return [];
  }
}

function parseParamsPreview(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function commandItemId(record: ReturnType<typeof parseCodexTranscriptRecord>[number], item: Record<string, unknown> | null) {
  return stringValue(record.metadata.itemId) ?? stringValue(item?.id) ?? paramsPreviewStringField(record.metadata.paramsPreview, "id");
}

function commandDurationFromTimestamps(startedAt: string | null | undefined, completedAt: string) {
  if (!startedAt) return null;
  const started = new Date(startedAt).getTime();
  const completed = new Date(completedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return completed - started;
}

function commandActionSummary(value: unknown) {
  if (!Array.isArray(value)) return "";
  const actions = value.flatMap((action) => {
    const record = objectValue(action);
    if (!record) return [];
    const type = stringValue(record.type);
    const name = stringValue(record.name);
    const command = stringValue(record.command);
    if (type && name) return `${type} ${name}`;
    if (type && command) return `${type} ${command}`;
    if (type) return type;
    return [];
  });
  return actions.slice(0, 3).join(", ");
}

function paramsPreviewStringField(value: unknown, key: string, options: { allowTruncated?: boolean } = {}) {
  if (typeof value !== "string") return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (match?.[1]) return decodeJsonStringFragment(match[1]);
  if (!options.allowTruncated) return null;
  const start = value.search(new RegExp(`"${escapedKey}"\\s*:\\s*"`));
  if (start < 0) return null;
  const prefix = value.slice(start).match(new RegExp(`^"${escapedKey}"\\s*:\\s*"`))?.[0];
  if (!prefix) return null;
  const rest = value.slice(start + prefix.length);
  const closing = rest.match(/"[,}]/);
  const raw = (closing ? rest.slice(0, closing.index) : rest).replace(/\.\.\.$/, "");
  return decodeJsonStringFragment(raw);
}

function paramsPreviewNumberField(value: unknown, key: string) {
  if (typeof value !== "string") return null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function decodeJsonStringFragment(value: string) {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

function transcriptItem(record: ReturnType<typeof parseCodexTranscriptRecord>[number], kind: CodexTranscriptItemKind, title: string, body: string) {
  return {
    id: `${kind}-${record.timestamp}-${title}`,
    kind,
    title,
    timestamp: record.timestamp,
    body,
    command: "",
    output: ""
  };
}

function transcriptSection(content: string, marker: string) {
  const index = content.indexOf(`\n${marker}`);
  if (index < 0) return "";
  const afterMarker = content.slice(index + marker.length + 1);
  const nextKnownSection = afterMarker.search(/\n(?:stderr:|error:|\[exit )/);
  const section = nextKnownSection > 0 ? afterMarker.slice(0, nextKnownSection) : afterMarker;
  return section.trim();
}

function objectValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numericValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "live";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}
