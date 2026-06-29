import { previewText } from "../util/logger.js";

const DEFAULT_CODEX_ACTIVITY_LOG_INTERVAL_MS = 30_000;
const MAX_RECENT_ITEMS = 20;
const MAX_SNIPPET_CHARS = 500;

type JsonRecord = Record<string, unknown>;

export type CodexActivityPhase = "planning" | "reasoning" | "command" | "file_change" | "message" | "tool" | "result" | "event";

export type CodexActivitySnapshot = {
  final: boolean;
  durationMs: number;
  silentForMs: number;
  longestOutputGapMs: number;
  totalEvents: number;
  eventTypes: Record<string, number>;
  phase: CodexActivityPhase | null;
  phaseDurationsMs: Record<string, number>;
  commandStarts: number;
  commandCompletions: number;
  commandFailures: number;
  activeCommands: number;
  lastCommand?: string;
  recentCommands: CodexCommandActivity[];
  repeatedCommands: Array<{ command: string; count: number }>;
  fileChangeStarts: number;
  fileChangeCompletions: number;
  filePaths: string[];
  recentFileChanges: string[];
  planUpdates: number;
  planSnippets: string[];
  reasoningChars: number;
  reasoningSnippets: string[];
  messageChars: number;
  messageSnippets: string[];
  toolUses: number;
  toolResults: number;
  jsonParseErrors: number;
  nonJsonLines: number;
  stderrBytes: number;
  stderrSnippets: string[];
  recentActivities: string[];
  lastEventType?: string;
  lastActivity?: string;
};

export type CodexCommandActivity = {
  command: string;
  status: "started" | "completed" | "failed";
  durationMs?: number;
  exitCode?: number;
};

export type CodexActivityTrackerOptions = {
  intervalMs?: number;
  now?: () => number;
  onSnapshot?: (snapshot: CodexActivitySnapshot) => void;
};

export class CodexActivityTracker {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly onSnapshot?: (snapshot: CodexActivitySnapshot) => void;
  private readonly startedAt: number;
  private lastSnapshotAt: number;
  private lastOutputAt: number;
  private longestOutputGapMs = 0;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private totalEvents = 0;
  private eventTypes: Record<string, number> = {};
  private phase: CodexActivityPhase | null = null;
  private phaseStartedAt: number;
  private phaseDurationsMs: Record<string, number> = {};
  private commandStarts = 0;
  private commandCompletions = 0;
  private commandFailures = 0;
  private readonly activeCommandIds = new Set<string>();
  private readonly completedCommandIds = new Set<string>();
  private readonly commandStartedAtById = new Map<string, number>();
  private readonly commandTextById = new Map<string, string>();
  private readonly commandCountsByText = new Map<string, number>();
  private readonly recentCommands: CodexCommandActivity[] = [];
  private lastCommand: string | undefined;
  private fileChangeStarts = 0;
  private fileChangeCompletions = 0;
  private readonly filePaths = new Set<string>();
  private readonly recentFileChanges: string[] = [];
  private planUpdates = 0;
  private readonly planSnippets: string[] = [];
  private reasoningChars = 0;
  private readonly reasoningSnippets: string[] = [];
  private messageChars = 0;
  private readonly messageSnippets: string[] = [];
  private toolUses = 0;
  private toolResults = 0;
  private jsonParseErrors = 0;
  private nonJsonLines = 0;
  private stderrBytes = 0;
  private readonly stderrSnippets: string[] = [];
  private readonly recentActivities: string[] = [];
  private lastEventType: string | undefined;
  private lastActivity: string | undefined;

  constructor(options: CodexActivityTrackerOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_CODEX_ACTIVITY_LOG_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.onSnapshot = options.onSnapshot;
    this.startedAt = this.now();
    this.lastSnapshotAt = this.startedAt;
    this.lastOutputAt = this.startedAt;
    this.phaseStartedAt = this.startedAt;
  }

  acceptStdout(text: string) {
    this.markOutput();
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.processLine(line);
    }
    this.emitIfDue();
  }

  acceptStderr(text: string) {
    this.markOutput();
    this.stderrBytes += Buffer.byteLength(text);
    this.stderrBuffer += text;
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      this.trackStderrLine(line);
    }
    this.emitIfDue();
  }

  heartbeat() {
    this.emitIfDue();
  }

  finish(): CodexActivitySnapshot {
    if (this.stdoutBuffer.trim()) {
      this.processLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
    if (this.stderrBuffer.trim()) {
      this.trackStderrLine(this.stderrBuffer);
      this.stderrBuffer = "";
    }
    this.closePhase(this.now());
    const snapshot = this.snapshot(true);
    this.onSnapshot?.(snapshot);
    return snapshot;
  }

  private processLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.nonJsonLines += 1;
      this.trackActivity(`stdout: ${previewText(trimmed, MAX_SNIPPET_CHARS)}`);
      return;
    }

    const event = normalizeCodexEvent(parsed);
    if (!event) {
      this.jsonParseErrors += 1;
      return;
    }

    this.processEvent(event);
  }

  private processEvent(event: JsonRecord) {
    const type = stringValue(event.type) || "unknown";
    this.totalEvents += 1;
    this.eventTypes[type] = (this.eventTypes[type] ?? 0) + 1;
    this.lastEventType = type;

    const command = commandExecution(event);
    const fileChange = fileChangeEvent(event);
    const reasoningDelta = reasoningText(event);
    const messageDelta = agentMessageText(event);
    const phase = classifyPhase(event, command, fileChange, reasoningDelta, messageDelta);
    this.setPhase(phase);

    if (isPlanEvent(event)) {
      this.planUpdates += 1;
      const snippet = planSnippet(event);
      if (snippet) pushLimited(this.planSnippets, snippet);
      this.trackActivity(snippet ? `Plan: ${snippet}` : "Updated plan");
    }

    if (command) {
      this.trackCommand(type, command);
    }

    if (fileChange) {
      this.trackFileChange(type, fileChange);
    }

    if (reasoningDelta) {
      this.reasoningChars += reasoningDelta.length;
      pushLimited(this.reasoningSnippets, previewText(reasoningDelta, MAX_SNIPPET_CHARS));
      this.trackActivity(`Reasoning summary +${reasoningDelta.length} chars`);
    }

    if (messageDelta) {
      this.messageChars += messageDelta.length;
      pushLimited(this.messageSnippets, previewText(messageDelta, MAX_SNIPPET_CHARS));
      this.trackActivity(`Message/commentary +${messageDelta.length} chars`);
    }

    const toolUseCount = toolUses(event);
    if (toolUseCount > 0) {
      this.toolUses += toolUseCount;
      this.trackActivity(`Tool use x${toolUseCount}`);
    }

    const toolResultCount = toolResults(event);
    if (toolResultCount > 0) {
      this.toolResults += toolResultCount;
      this.trackActivity(`Tool result x${toolResultCount}`);
    }

    if (isTerminalEvent(event)) {
      this.trackActivity("Codex terminal event");
    }
  }

  private trackCommand(eventType: string, command: JsonRecord) {
    const id = commandId(command);
    const commandText = commandTextForLog(command);
    if (commandText) {
      this.lastCommand = commandText;
      this.trackActivity(`Command: ${commandText}`);
    }

    if (!this.activeCommandIds.has(id) && !this.completedCommandIds.has(id)) {
      this.activeCommandIds.add(id);
      this.commandStartedAtById.set(id, this.now());
      if (commandText) {
        this.commandTextById.set(id, commandText);
        this.commandCountsByText.set(commandText, (this.commandCountsByText.get(commandText) ?? 0) + 1);
      }
      this.commandStarts += 1;
      this.pushCommandActivity({
        command: commandText || id,
        status: "started"
      });
    }

    if (isCommandComplete(eventType, command) && !this.completedCommandIds.has(id)) {
      this.completedCommandIds.add(id);
      this.activeCommandIds.delete(id);
      this.commandCompletions += 1;
      const failed = isCommandFailure(eventType, command);
      if (failed) this.commandFailures += 1;
      const startedAt = this.commandStartedAtById.get(id) ?? this.now();
      const exitCode = numberValue(command.exitCode) ?? numberValue(command.exit_code);
      this.pushCommandActivity({
        command: commandText || this.commandTextById.get(id) || id,
        status: failed ? "failed" : "completed",
        durationMs: Math.max(0, this.now() - startedAt),
        exitCode
      });
    }
  }

  private trackFileChange(eventType: string, fileChange: JsonRecord) {
    this.fileChangeStarts += eventType === "item.completed" ? 0 : 1;
    if (eventType === "item.completed") this.fileChangeCompletions += 1;
    for (const filePath of filePaths(fileChange)) {
      this.filePaths.add(filePath);
      pushLimited(this.recentFileChanges, filePath);
    }
    const paths = filePaths(fileChange);
    this.trackActivity(paths.length ? `File change: ${paths.slice(0, 3).join(", ")}` : "File change");
  }

  private emitIfDue() {
    const now = this.now();
    if (now - this.lastSnapshotAt < this.intervalMs) return;
    this.closePhase(now);
    this.lastSnapshotAt = now;
    this.onSnapshot?.(this.snapshot(false));
  }

  private setPhase(nextPhase: CodexActivityPhase) {
    const now = this.now();
    if (this.phase === nextPhase) return;
    this.closePhase(now);
    this.phase = nextPhase;
    this.phaseStartedAt = now;
  }

  private closePhase(now: number) {
    if (!this.phase) return;
    this.phaseDurationsMs[this.phase] = (this.phaseDurationsMs[this.phase] ?? 0) + Math.max(0, now - this.phaseStartedAt);
    this.phaseStartedAt = now;
  }

  private snapshot(final: boolean): CodexActivitySnapshot {
    const now = this.now();
    const phaseDurationsMs = { ...this.phaseDurationsMs };
    if (this.phase && !final) {
      phaseDurationsMs[this.phase] = (phaseDurationsMs[this.phase] ?? 0) + Math.max(0, now - this.phaseStartedAt);
    }
    return {
      final,
      durationMs: Math.max(0, now - this.startedAt),
      silentForMs: Math.max(0, now - this.lastOutputAt),
      longestOutputGapMs: Math.max(this.longestOutputGapMs, Math.max(0, now - this.lastOutputAt)),
      totalEvents: this.totalEvents,
      eventTypes: { ...this.eventTypes },
      phase: this.phase,
      phaseDurationsMs,
      commandStarts: this.commandStarts,
      commandCompletions: this.commandCompletions,
      commandFailures: this.commandFailures,
      activeCommands: this.activeCommandIds.size,
      lastCommand: this.lastCommand,
      recentCommands: [...this.recentCommands],
      repeatedCommands: repeatedCommands(this.commandCountsByText),
      fileChangeStarts: this.fileChangeStarts,
      fileChangeCompletions: this.fileChangeCompletions,
      filePaths: Array.from(this.filePaths).slice(0, 20),
      recentFileChanges: [...this.recentFileChanges],
      planUpdates: this.planUpdates,
      planSnippets: [...this.planSnippets],
      reasoningChars: this.reasoningChars,
      reasoningSnippets: [...this.reasoningSnippets],
      messageChars: this.messageChars,
      messageSnippets: [...this.messageSnippets],
      toolUses: this.toolUses,
      toolResults: this.toolResults,
      jsonParseErrors: this.jsonParseErrors,
      nonJsonLines: this.nonJsonLines,
      stderrBytes: this.stderrBytes,
      stderrSnippets: [...this.stderrSnippets],
      recentActivities: [...this.recentActivities],
      lastEventType: this.lastEventType,
      lastActivity: this.lastActivity
    };
  }

  private markOutput() {
    const now = this.now();
    this.longestOutputGapMs = Math.max(this.longestOutputGapMs, Math.max(0, now - this.lastOutputAt));
    this.lastOutputAt = now;
  }

  private trackActivity(activity: string) {
    const trimmed = previewText(activity.trim(), MAX_SNIPPET_CHARS);
    if (!trimmed) return;
    this.lastActivity = trimmed;
    pushLimited(this.recentActivities, trimmed);
  }

  private trackStderrLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    const snippet = previewText(trimmed, MAX_SNIPPET_CHARS);
    pushLimited(this.stderrSnippets, snippet);
    this.trackActivity(`stderr: ${snippet}`);
  }

  private pushCommandActivity(command: CodexCommandActivity) {
    pushLimited(this.recentCommands, {
      ...command,
      command: previewText(command.command, MAX_SNIPPET_CHARS)
    });
  }
}

function normalizeCodexEvent(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.type === "string") return value;
  if (typeof value.method !== "string") return null;
  const params = isRecord(value.params) ? value.params : {};
  return {
    ...params,
    type: value.method.replace(/\//g, ".")
  };
}

function classifyPhase(
  event: JsonRecord,
  command: JsonRecord | null,
  fileChange: JsonRecord | null,
  reasoningDelta: string,
  messageDelta: string
): CodexActivityPhase {
  if (command) return "command";
  if (fileChange) return "file_change";
  if (isPlanEvent(event)) return "planning";
  if (reasoningDelta) return "reasoning";
  if (toolUses(event) > 0 || toolResults(event) > 0) return "tool";
  if (messageDelta) return "message";
  if (isTerminalEvent(event)) return "result";
  return "event";
}

function commandExecution(event: JsonRecord): JsonRecord | null {
  if (event.type === "command_execution") return event;
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;
  const item = recordValue(event.item);
  if (!item) return null;
  const itemType = stringValue(item.type);
  return itemType === "commandExecution" || itemType === "command_execution" ? item : null;
}

function fileChangeEvent(event: JsonRecord): JsonRecord | null {
  if (event.type === "file_change") return event;
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") return null;
  const item = recordValue(event.item);
  if (!item) return null;
  const itemType = stringValue(item.type);
  return itemType === "fileChange" || itemType === "file_change" ? item : null;
}

function isPlanEvent(event: JsonRecord) {
  return event.type === "turn.plan.updated" || event.type === "item.plan.delta" || event.type === "plan";
}

function planSnippet(event: JsonRecord) {
  if (event.type === "turn.plan.updated" && Array.isArray(event.plan)) {
    return previewText(
      event.plan
        .map((item) => (isRecord(item) ? stringValue(item.step) || stringValue(item.title) : ""))
        .filter(Boolean)
        .join(" | "),
      MAX_SNIPPET_CHARS
    );
  }
  return previewText(stringValue(event.delta) || stringValue(event.text) || stringValue(event.title), MAX_SNIPPET_CHARS);
}

function isTerminalEvent(event: JsonRecord) {
  return event.type === "result" || event.type === "turn.done" || event.type === "turn.completed";
}

function reasoningText(event: JsonRecord): string {
  if (event.type === "item.reasoning.summaryTextDelta" || event.type === "item.reasoning.textDelta") {
    return stringValue(event.delta);
  }
  if (event.type !== "reasoning") return "";
  return stringValue(event.text) || stringValue(event.thinking);
}

function agentMessageText(event: JsonRecord): string {
  if (event.type === "item.agentMessage.delta") {
    const delta = event.delta;
    if (isRecord(delta)) return stringValue(delta.text) || stringValue(delta.content);
    return stringValue(delta) || stringValue(event.text) || stringValue(event.content);
  }
  if (event.type === "item.completed") {
    const item = recordValue(event.item);
    const itemType = stringValue(item?.type);
    if (itemType === "agentMessage" || itemType === "agent_message") return stringValue(item?.text);
  }
  if (event.type !== "assistant") return "";
  return contentParts(event)
    .map((part) => (stringValue(part.type) === "text" ? stringValue(part.text) : ""))
    .filter(Boolean)
    .join("");
}

function toolUses(event: JsonRecord): number {
  if (event.type !== "assistant") return 0;
  return contentParts(event).filter((part) => stringValue(part.type) === "tool_use").length;
}

function toolResults(event: JsonRecord): number {
  if (event.type !== "user" && event.type !== "tool") return 0;
  const direct = Array.isArray(event.content) ? event.content : [];
  return direct.filter((part) => isRecord(part) && (stringValue(part.type) === "tool_result" || typeof part.tool_use_id === "string")).length;
}

function contentParts(event: JsonRecord): JsonRecord[] {
  const message = recordValue(event.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.filter(isRecord);
}

function commandId(command: JsonRecord): string {
  return (
    stringValue(command.id) ||
    stringValue(command.itemId) ||
    stringValue(command.item_id) ||
    stringValue(command.command_id) ||
    commandTextForLog(command) ||
    "command"
  );
}

function commandTextForLog(command: JsonRecord): string {
  const raw =
    stringValue(command.command) ||
    stringValue(command.cmd) ||
    stringValue(command.commandLine) ||
    stringValue(command.command_line) ||
    stringValue(command.input);
  return previewText(unwrapShellCommand(raw), 240);
}

function isCommandComplete(eventType: string, command: JsonRecord): boolean {
  const status = stringValue(command.status).toLowerCase();
  return eventType === "item.completed" || status === "completed" || status === "complete" || status === "failed" || status === "error";
}

function isCommandFailure(eventType: string, command: JsonRecord): boolean {
  const status = stringValue(command.status).toLowerCase();
  const exitCode = numberValue(command.exitCode) ?? numberValue(command.exit_code);
  return status === "failed" || status === "error" || (eventType === "item.completed" && exitCode !== undefined && exitCode !== 0);
}

function filePaths(fileChange: JsonRecord): string[] {
  const directPath = stringValue(fileChange.path) || stringValue(fileChange.file_path);
  const changes = Array.isArray(fileChange.changes) ? fileChange.changes : [];
  return [
    directPath,
    ...changes.map((change) => (isRecord(change) ? stringValue(change.path) || stringValue(change.file_path) : ""))
  ].filter(Boolean);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const bashLc = /^\/bin\/bash\s+-lc\s+([\s\S]+)$/i.exec(trimmed);
  if (!bashLc?.[1]) return trimmed;
  let inner = bashLc[1].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    inner = inner.slice(1, -1);
  }
  return inner.trim() || trimmed;
}

function recordValue(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pushLimited<T>(items: T[], item: T) {
  items.push(item);
  if (items.length > MAX_RECENT_ITEMS) {
    items.splice(0, items.length - MAX_RECENT_ITEMS);
  }
}

function repeatedCommands(commandCountsByText: Map<string, number>) {
  return Array.from(commandCountsByText.entries())
    .filter(([, count]) => count > 1)
    .sort((left, right) => right[1] - left[1])
    .slice(0, MAX_RECENT_ITEMS)
    .map(([command, count]) => ({ command, count }));
}
