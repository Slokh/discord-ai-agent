export function renderTaskListPage() {
  return htmlPage({
    title: "Agent Tasks",
    body: `
      <main class="shell">
        <header class="topbar">
          <div>
            <p class="eyebrow">Discord AI Agent</p>
            <h1>Agent Tasks</h1>
          </div>
          <button id="refresh" type="button">Refresh</button>
        </header>
        <section id="status" class="notice">Loading recent tasks...</section>
        <section id="tasks" class="task-list"></section>
      </main>
      <script>
        ${taskListScript()}
      </script>
    `
  });
}

export function renderTaskTerminalPage(taskId: string) {
  return htmlPage({
    title: `Agent Task ${taskId}`,
    body: `
      <main class="shell">
        <header class="topbar">
          <div>
            <p class="eyebrow"><a href="/tasks">Agent Tasks</a></p>
            <h1 id="title">Agent Task</h1>
          </div>
          <button id="refresh" type="button">Refresh</button>
        </header>
        <section id="summary" class="summary-grid"></section>
        <section class="panel">
          <h2>Terminal</h2>
          <pre id="terminal" class="terminal">Loading task output...</pre>
        </section>
        <section class="two-column">
          <div class="panel">
            <h2>Timeline</h2>
            <ol id="timeline" class="timeline"></ol>
          </div>
          <div class="panel">
            <h2>Sandbox</h2>
            <div id="sandbox" class="details"></div>
          </div>
        </section>
      </main>
      <script>
        window.AGENT_TASK_ID = ${scriptJson(taskId)};
        ${taskTerminalScript()}
      </script>
    `
  });
}

function htmlPage(input: { title: string; body: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0f14;
      --panel: #111821;
      --panel-2: #0f151d;
      --border: #253142;
      --text: #d8e1ec;
      --muted: #8fa0b3;
      --accent: #7cc7ff;
      --good: #7be29a;
      --bad: #ff8f8f;
      --warn: #ffd27a;
      --terminal: #05080c;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    button {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #17202b;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      min-height: 36px;
      padding: 0 12px;
    }

    button:hover {
      border-color: var(--accent);
    }

    .shell {
      width: min(1280px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0 36px;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }

    .eyebrow {
      margin: 0 0 4px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
    }

    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }

    h1 {
      font-size: clamp(24px, 3vw, 34px);
      line-height: 1.1;
    }

    h2 {
      font-size: 14px;
      margin-bottom: 12px;
      color: var(--muted);
      text-transform: uppercase;
    }

    .notice,
    .panel,
    .task-card,
    .summary-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
    }

    .notice {
      padding: 12px 14px;
      color: var(--muted);
      margin-bottom: 14px;
    }

    .task-list {
      display: grid;
      gap: 10px;
    }

    .task-card {
      display: grid;
      gap: 8px;
      padding: 14px;
    }

    .task-card-header,
    .meta-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .task-title {
      color: var(--text);
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .request,
    .meta-row,
    .details,
    .timeline {
      color: var(--muted);
    }

    .request {
      margin: 0;
      max-width: 80ch;
      overflow-wrap: anywhere;
    }

    .status-pill {
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      padding: 6px 8px;
      white-space: nowrap;
    }

    .status-running,
    .status-queued {
      border-color: var(--warn);
      color: var(--warn);
    }

    .status-succeeded {
      border-color: var(--good);
      color: var(--good);
    }

    .status-failed,
    .status-no_changes,
    .status-cancelled {
      border-color: var(--bad);
      color: var(--bad);
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }

    .summary-card {
      min-height: 84px;
      padding: 12px;
    }

    .summary-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
    }

    .summary-value {
      overflow-wrap: anywhere;
    }

    .panel {
      padding: 14px;
      margin-bottom: 14px;
    }

    .terminal {
      background: var(--terminal);
      border: 1px solid #1a2330;
      border-radius: 6px;
      color: #d9f0ff;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      margin: 0;
      max-height: 68vh;
      min-height: 360px;
      overflow: auto;
      padding: 14px;
      tab-size: 2;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .two-column {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
      gap: 14px;
    }

    .timeline {
      display: grid;
      gap: 10px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .timeline-item {
      border-left: 2px solid var(--border);
      padding-left: 10px;
    }

    .timeline-time,
    .detail-label {
      color: var(--muted);
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-transform: uppercase;
    }

    .timeline-summary {
      color: var(--text);
      margin: 2px 0;
    }

    .metadata {
      color: var(--muted);
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      margin: 4px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .details {
      display: grid;
      gap: 10px;
    }

    .detail-card {
      background: var(--panel-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      overflow-wrap: anywhere;
    }

    @media (max-width: 900px) {
      .summary-grid,
      .two-column {
        grid-template-columns: 1fr;
      }

      .task-card-header,
      .meta-row {
        align-items: flex-start;
        flex-direction: column;
      }
    }
  </style>
</head>
<body>
${input.body}
</body>
</html>`;
}

function taskListScript() {
  return String.raw`
const statusEl = document.getElementById("status");
const tasksEl = document.getElementById("tasks");
const refreshEl = document.getElementById("refresh");

refreshEl.addEventListener("click", refresh);
refresh();
setInterval(refresh, 5000);

async function refresh() {
  try {
    const response = await fetch("/api/tasks?limit=50", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    renderTasks(data.tasks || []);
    statusEl.textContent = "Showing " + (data.tasks || []).length + " recent tasks. Auto-refreshing every 5s.";
  } catch (error) {
    statusEl.textContent = "Failed to load tasks: " + error.message;
  }
}

function renderTasks(tasks) {
  tasksEl.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "No agent tasks yet.";
    tasksEl.append(empty);
    return;
  }
  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = "task-card";

    const header = document.createElement("div");
    header.className = "task-card-header";

    const link = document.createElement("a");
    link.className = "task-title";
    link.href = "/tasks/" + encodeURIComponent(task.taskId);
    link.textContent = task.title || task.taskId;

    const pill = statusPill(task.status);
    header.append(link, pill);

    const request = document.createElement("p");
    request.className = "request";
    request.textContent = task.request || "";

    const meta = document.createElement("div");
    meta.className = "meta-row";
    meta.textContent = [
      task.currentStep ? "step " + task.currentStep : null,
      task.statusMessage || null,
      task.updatedAt ? "updated " + formatDate(task.updatedAt) : null
    ].filter(Boolean).join(" | ");

    card.append(header, request, meta);
    tasksEl.append(card);
  }
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill status-" + String(status || "unknown").replace(/[^a-z_]/g, "");
  pill.textContent = status || "unknown";
  return pill;
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}
`;
}

function taskTerminalScript() {
  return String.raw`
const taskId = window.AGENT_TASK_ID;
const titleEl = document.getElementById("title");
const summaryEl = document.getElementById("summary");
const terminalEl = document.getElementById("terminal");
const timelineEl = document.getElementById("timeline");
const sandboxEl = document.getElementById("sandbox");
const refreshEl = document.getElementById("refresh");

let lastTerminalText = "";
refreshEl.addEventListener("click", refresh);
refresh();
setInterval(refresh, 2500);

async function refresh() {
  try {
    const response = await fetch("/api/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const snapshot = await response.json();
    renderSnapshot(snapshot);
  } catch (error) {
    terminalEl.textContent = "Failed to load task: " + error.message;
  }
}

function renderSnapshot(snapshot) {
  const task = snapshot.task;
  titleEl.textContent = task.title || task.taskId;
  renderSummary(task);
  renderTerminal(snapshot);
  renderTimeline(snapshot.events || []);
  renderSandbox(snapshot);
}

function renderSummary(task) {
  summaryEl.replaceChildren(
    summaryCard("Status", task.status || "unknown", statusPill(task.status)),
    summaryCard("Current Step", [task.currentStep, task.statusMessage].filter(Boolean).join(" | ") || "none"),
    summaryCard("Pull Request", task.prUrl || "not opened yet", task.prUrl ? link(task.prUrl, task.prUrl) : null),
    summaryCard("Task ID", task.taskId || "")
  );
}

function summaryCard(label, value, replacement) {
  const card = document.createElement("article");
  card.className = "summary-card";
  const labelEl = document.createElement("div");
  labelEl.className = "summary-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "summary-value";
  if (replacement) valueEl.append(replacement);
  else valueEl.textContent = value;
  card.append(labelEl, valueEl);
  return card;
}

function renderTerminal(snapshot) {
  const text = terminalText(snapshot);
  const shouldStickToBottom = terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 24;
  if (text !== lastTerminalText) {
    terminalEl.textContent = text;
    lastTerminalText = text;
    if (shouldStickToBottom) terminalEl.scrollTop = terminalEl.scrollHeight;
  }
}

function terminalText(snapshot) {
  const task = snapshot.task;
  const lines = [];
  lines.push("$ agent-task-context");
  lines.push("Task ID: " + task.taskId);
  lines.push("Status: " + task.status);
  if (task.currentStep) lines.push("Step: " + task.currentStep);
  if (task.statusMessage) lines.push("Message: " + task.statusMessage);
  if (task.prUrl) lines.push("PR: " + task.prUrl);
  if (task.error) lines.push("Error: " + task.error);
  lines.push("");

  for (const command of snapshot.commands || []) {
    lines.push("[" + formatDate(command.createdAt) + "] $ " + (command.command || command.step));
    if (command.outputTail) {
      lines.push(command.outputTail.trimEnd());
    }
    if (command.errorTail) {
      lines.push(command.errorTail.trimEnd());
    }
    lines.push("[exit " + nullish(command.exitCode, "?") + " after " + formatDuration(command.durationMs) + "]");
    lines.push("");
  }

  const live = isActiveTaskStatus(task.status) ? latestLiveOutput(snapshot.events || []) : null;
  if (live) {
    lines.push("[" + formatDate(live.createdAt) + "] $ " + (live.metadata.command || live.metadata.step || live.eventName));
    if (live.metadata.stdoutTail) lines.push(String(live.metadata.stdoutTail).trimEnd());
    if (live.metadata.stderrTail) lines.push(String(live.metadata.stderrTail).trimEnd());
    lines.push("[running for " + formatDuration(live.metadata.durationMs) + "]");
    lines.push("");
  }

  if (!(snapshot.commands || []).length && !live) {
    lines.push("No command output has been recorded yet. The sandbox may still be starting.");
  }
  return lines.join("\n");
}

function latestLiveOutput(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const metadata = event.metadata || {};
    if (metadata.stdoutTail || metadata.stderrTail) return event;
  }
  return null;
}

function isActiveTaskStatus(status) {
  return status === "queued" || status === "running";
}

function renderTimeline(events) {
  timelineEl.replaceChildren();
  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "timeline-item";
    empty.textContent = "No task events yet.";
    timelineEl.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    const time = document.createElement("div");
    time.className = "timeline-time";
    time.textContent = formatDate(event.createdAt) + " | " + event.eventName;
    const summary = document.createElement("div");
    summary.className = "timeline-summary";
    summary.textContent = event.summary || "";
    item.append(time, summary);
    const metadata = compactMetadata(event.metadata || {});
    if (metadata) {
      const metadataEl = document.createElement("pre");
      metadataEl.className = "metadata";
      metadataEl.textContent = metadata;
      item.append(metadataEl);
    }
    timelineEl.append(item);
  }
}

function renderSandbox(snapshot) {
  sandboxEl.replaceChildren();
  const runs = snapshot.runs || [];
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "detail-card";
    empty.textContent = "No sandbox run has been recorded yet.";
    sandboxEl.append(empty);
    return;
  }
  for (const run of runs) {
    const card = document.createElement("div");
    card.className = "detail-card";
    card.append(detail("Sandbox run", run.sandboxRunId));
    card.append(detail("Backend", run.backend));
    card.append(detail("Job", [run.namespace, run.backendJobName].filter(Boolean).join("/") || "unknown"));
    card.append(detail("Status", run.status));
    card.append(detail("Image", run.image || "unknown"));
    sandboxEl.append(card);
  }
}

function detail(label, value) {
  const wrapper = document.createElement("div");
  const labelEl = document.createElement("div");
  labelEl.className = "detail-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.textContent = value || "";
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill status-" + String(status || "unknown").replace(/[^a-z_]/g, "");
  pill.textContent = status || "unknown";
  return pill;
}

function link(href, label) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  return anchor;
}

function compactMetadata(metadata) {
  const copy = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "stdoutTail" || key === "stderrTail") continue;
    copy[key] = value;
  }
  return Object.keys(copy).length ? JSON.stringify(copy, null, 2) : "";
}

function nullish(value, fallback) {
  return value === null || value === undefined ? fallback : value;
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return "unknown";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  return Math.floor(ms / 60000) + "m " + Math.round((ms % 60000) / 1000) + "s";
}

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}
`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function scriptJson(value: string) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
