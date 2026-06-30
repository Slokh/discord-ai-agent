export function renderTaskListPage() {
  return htmlPage({
    title: "Agent Tasks",
    body: `
      <main class="shell">
        <header class="app-header">
          <div class="title-block">
            <p class="eyebrow">Agent Ops</p>
            <h1>Agent Tasks</h1>
          </div>
          <div class="header-actions">
            <button id="refresh" class="button primary" type="button">Refresh</button>
            <a class="button" href="/logout">Sign out</a>
          </div>
        </header>

        <section id="summary" class="metrics-grid" aria-label="Task summary"></section>

        <section class="toolbar" aria-label="Task filters">
          <div class="segmented" role="tablist" aria-label="Status filter">
            <button class="segment active" type="button" data-filter="all">All</button>
            <button class="segment" type="button" data-filter="active">Active</button>
            <button class="segment" type="button" data-filter="done">Done</button>
            <button class="segment" type="button" data-filter="attention">Needs Review</button>
          </div>
          <label class="search-box">
            <span>Search</span>
            <input id="search" type="search" autocomplete="off" spellcheck="false" placeholder="title, request, task id">
          </label>
          <div id="status" class="live-note">Loading...</div>
        </section>

        <section id="tasks" class="task-table" aria-live="polite"></section>
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
      <main class="shell wide">
        <header class="app-header">
          <div class="title-block">
            <p class="eyebrow"><a href="/tasks">Agent Tasks</a></p>
            <h1 id="title">Agent Task</h1>
            <p id="titleMeta" class="title-meta"></p>
          </div>
          <div class="header-actions">
            <button id="copyLink" class="button" type="button">Copy Link</button>
            <button id="refresh" class="button primary" type="button">Refresh</button>
            <a class="button" href="/logout">Sign out</a>
          </div>
        </header>

        <section id="overview" class="metrics-grid compact" aria-label="Task overview"></section>

        <section class="request-panel">
          <div class="section-label">Request</div>
          <p id="requestText"></p>
        </section>

        <section class="workspace-grid">
          <section class="terminal-card">
            <div class="panel-heading">
              <div>
                <div class="section-label">Terminal</div>
                <div id="terminalStatus" class="terminal-status">Loading output...</div>
              </div>
              <label class="toggle">
                <input id="autoScroll" type="checkbox" checked>
                <span>Auto-scroll</span>
              </label>
            </div>
            <pre id="terminal" class="terminal">Loading task output...</pre>
          </section>

          <aside class="side-card">
            <div class="tabs" role="tablist" aria-label="Task details">
              <button class="tab active" type="button" data-panel="timeline">Timeline</button>
              <button class="tab" type="button" data-panel="sandbox">Sandbox</button>
              <button class="tab" type="button" data-panel="commands">Commands</button>
            </div>
            <div id="timelinePanel" class="tab-panel active">
              <ol id="timeline" class="timeline"></ol>
            </div>
            <div id="sandboxPanel" class="tab-panel">
              <div id="sandbox" class="details"></div>
            </div>
            <div id="commandsPanel" class="tab-panel">
              <div id="commands" class="command-list"></div>
            </div>
          </aside>
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
      --bg: #090b0e;
      --surface: #101418;
      --surface-2: #151a20;
      --surface-3: #1b222a;
      --line: #27313b;
      --line-strong: #3a4653;
      --text: #edf3f8;
      --muted: #9aa8b6;
      --faint: #6f7d8b;
      --accent: #8fd6bd;
      --blue: #8db7ff;
      --green: #82d996;
      --amber: #f4c76c;
      --red: #ff8f94;
      --terminal: #050607;
      --shadow: 0 18px 60px rgba(0, 0, 0, 0.32);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(143, 214, 189, 0.08), transparent 320px),
        var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    a {
      color: var(--accent);
      text-decoration: none;
    }

    button,
    input {
      font: inherit;
    }

    button {
      cursor: pointer;
    }

    .shell {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 42px;
    }

    .shell.wide {
      width: min(1440px, calc(100vw - 32px));
    }

    .app-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 18px;
    }

    .title-block {
      min-width: 0;
    }

    .eyebrow,
    .section-label,
    .metric-label,
    .field-label {
      color: var(--faint);
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      letter-spacing: 0;
      margin: 0 0 7px;
      text-transform: uppercase;
    }

    h1 {
      font-size: clamp(28px, 4vw, 44px);
      letter-spacing: 0;
      line-height: 1;
      margin: 0;
    }

    .title-meta {
      color: var(--muted);
      margin: 10px 0 0;
      overflow-wrap: anywhere;
    }

    .header-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }

    .button {
      align-items: center;
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 7px;
      color: var(--text);
      display: inline-flex;
      min-height: 36px;
      padding: 0 12px;
      white-space: nowrap;
    }

    .button:hover,
    .segment:hover,
    .tab:hover {
      border-color: var(--line-strong);
      color: var(--text);
    }

    .button.primary {
      background: #dff8ec;
      border-color: #dff8ec;
      color: #06100b;
      font-weight: 700;
    }

    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }

    .metrics-grid.compact {
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }

    .metric-card,
    .toolbar,
    .task-table,
    .request-panel,
    .terminal-card,
    .side-card {
      background: rgba(16, 20, 24, 0.94);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .metric-card {
      min-height: 86px;
      padding: 14px;
    }

    .metric-value {
      align-items: center;
      display: flex;
      gap: 8px;
      min-height: 28px;
      overflow-wrap: anywhere;
    }

    .metric-value.large {
      font-size: 26px;
      font-weight: 800;
      line-height: 1;
    }

    .metric-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
      overflow-wrap: anywhere;
    }

    .toolbar {
      align-items: center;
      display: grid;
      gap: 12px;
      grid-template-columns: auto minmax(240px, 1fr) auto;
      margin-bottom: 12px;
      padding: 10px;
    }

    .segmented,
    .tabs {
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      display: inline-flex;
      gap: 2px;
      padding: 3px;
    }

    .segment,
    .tab {
      appearance: none;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: var(--muted);
      min-height: 30px;
      padding: 0 10px;
    }

    .segment.active,
    .tab.active {
      background: var(--surface-3);
      border-color: var(--line);
      color: var(--text);
    }

    .search-box {
      align-items: center;
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--faint);
      display: grid;
      gap: 8px;
      grid-template-columns: auto 1fr;
      min-height: 38px;
      padding: 0 10px;
    }

    .search-box span {
      font-size: 12px;
    }

    .search-box input {
      background: transparent;
      border: 0;
      color: var(--text);
      min-width: 0;
      outline: 0;
    }

    .live-note {
      color: var(--muted);
      font-size: 12px;
      text-align: right;
      white-space: nowrap;
    }

    .task-table {
      overflow: hidden;
    }

    .table-heading,
    .task-row {
      display: grid;
      gap: 12px;
      grid-template-columns: minmax(220px, 1.45fr) minmax(160px, 0.9fr) minmax(120px, 0.7fr) minmax(96px, 0.6fr);
      padding: 12px 14px;
    }

    .table-heading {
      background: rgba(21, 26, 32, 0.78);
      border-bottom: 1px solid var(--line);
      color: var(--faint);
      font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-transform: uppercase;
    }

    .task-row {
      border-bottom: 1px solid rgba(39, 49, 59, 0.72);
      color: var(--text);
      min-height: 76px;
      transition: background 120ms ease, border-color 120ms ease;
    }

    .task-row:hover {
      background: rgba(27, 34, 42, 0.72);
    }

    .task-row:last-child {
      border-bottom: 0;
    }

    .task-main,
    .task-step,
    .task-time,
    .task-pr {
      min-width: 0;
    }

    .task-title {
      color: var(--text);
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .task-request {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .task-step,
    .task-time,
    .task-pr,
    .empty-state {
      color: var(--muted);
    }

    .task-step strong {
      color: var(--text);
      display: block;
      font-size: 13px;
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .task-step span,
    .task-time span {
      display: block;
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty-state {
      padding: 34px 18px;
      text-align: center;
    }

    .status-pill {
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      display: inline-flex;
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      gap: 6px;
      min-height: 26px;
      padding: 0 9px;
      white-space: nowrap;
    }

    .status-pill::before {
      background: currentColor;
      border-radius: 999px;
      content: "";
      height: 6px;
      width: 6px;
    }

    .tone-active {
      border-color: rgba(244, 199, 108, 0.58);
      color: var(--amber);
    }

    .tone-success {
      border-color: rgba(130, 217, 150, 0.58);
      color: var(--green);
    }

    .tone-danger {
      border-color: rgba(255, 143, 148, 0.58);
      color: var(--red);
    }

    .tone-neutral {
      color: var(--muted);
    }

    .request-panel {
      margin-bottom: 14px;
      padding: 14px;
    }

    .request-panel p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .workspace-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: minmax(0, 1.55fr) minmax(360px, 0.85fr);
      align-items: start;
    }

    .terminal-card,
    .side-card {
      min-width: 0;
      overflow: hidden;
    }

    .panel-heading {
      align-items: center;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
    }

    .terminal-status {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
    }

    .toggle {
      align-items: center;
      color: var(--muted);
      display: inline-flex;
      gap: 8px;
      white-space: nowrap;
    }

    .toggle input {
      accent-color: var(--accent);
    }

    .terminal {
      background: var(--terminal);
      border: 0;
      color: #e7f7ff;
      font: 12px/1.48 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      margin: 0;
      max-height: 70vh;
      min-height: 560px;
      overflow: auto;
      padding: 14px;
      tab-size: 2;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tabs {
      border-bottom: 1px solid var(--line);
      border-left: 0;
      border-radius: 0;
      border-right: 0;
      border-top: 0;
      display: flex;
      padding: 8px;
      width: 100%;
    }

    .tab-panel {
      display: none;
      max-height: 72vh;
      overflow: auto;
      padding: 14px;
    }

    .tab-panel.active {
      display: block;
    }

    .timeline {
      display: grid;
      gap: 10px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .timeline-item {
      border-left: 2px solid var(--line);
      padding-left: 11px;
    }

    .timeline-time,
    .command-meta,
    .detail-label {
      color: var(--faint);
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      text-transform: uppercase;
    }

    .timeline-summary,
    .command-title {
      color: var(--text);
      margin: 3px 0;
      overflow-wrap: anywhere;
    }

    .metadata {
      color: var(--muted);
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      margin: 5px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .details,
    .command-list {
      display: grid;
      gap: 10px;
    }

    .detail-card,
    .command-card {
      background: rgba(21, 26, 32, 0.68);
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      overflow-wrap: anywhere;
    }

    .detail-card {
      display: grid;
      gap: 10px;
    }

    @media (max-width: 1080px) {
      .metrics-grid,
      .metrics-grid.compact,
      .workspace-grid {
        grid-template-columns: 1fr 1fr;
      }

      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 760px) {
      .shell {
        width: min(100vw - 20px, 1180px);
        padding-top: 18px;
      }

      .app-header,
      .header-actions {
        align-items: stretch;
        flex-direction: column;
      }

      .metrics-grid,
      .metrics-grid.compact,
      .toolbar,
      .table-heading,
      .task-row {
        grid-template-columns: 1fr;
      }

      .table-heading {
        display: none;
      }

      .toolbar {
        align-items: stretch;
      }

      .segmented {
        overflow-x: auto;
      }

      .live-note {
        text-align: left;
      }

      .terminal {
        min-height: 420px;
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
const state = { tasks: [], filter: "all", query: "" };
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const tasksEl = document.getElementById("tasks");
const refreshEl = document.getElementById("refresh");
const searchEl = document.getElementById("search");
const filterEls = Array.from(document.querySelectorAll("[data-filter]"));

refreshEl.addEventListener("click", refresh);
searchEl.addEventListener("input", () => {
  state.query = searchEl.value.trim().toLowerCase();
  render();
});
for (const button of filterEls) {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter || "all";
    for (const item of filterEls) item.classList.toggle("active", item === button);
    render();
  });
}

refresh();
setInterval(refresh, 5000);

async function refresh() {
  try {
    const response = await fetch("/api/tasks?limit=100", { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    state.tasks = data.tasks || [];
    render();
    statusEl.textContent = "Updated " + formatTime(new Date());
  } catch (error) {
    statusEl.textContent = "Load failed: " + error.message;
  }
}

function render() {
  renderSummary(state.tasks);
  renderTasks(filteredTasks());
}

function renderSummary(tasks) {
  const active = tasks.filter((task) => isActiveTaskStatus(task.status)).length;
  const done = tasks.filter((task) => task.status === "succeeded").length;
  const attention = tasks.filter((task) => isAttentionStatus(task.status)).length;
  const latest = tasks[0]?.updatedAt ? formatAge(tasks[0].updatedAt) : "none";
  summaryEl.replaceChildren(
    metric("Active", active, "running or queued"),
    metric("Done", done, "recent successes"),
    metric("Needs Review", attention, "failed, cancelled, or no diff"),
    metric("Latest", latest, "most recent update")
  );
}

function renderTasks(tasks) {
  tasksEl.replaceChildren();
  const header = document.createElement("div");
  header.className = "table-heading";
  for (const label of ["Task", "Step", "Updated", "Result"]) {
    const cell = document.createElement("div");
    cell.textContent = label;
    header.append(cell);
  }
  tasksEl.append(header);

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No matching tasks.";
    tasksEl.append(empty);
    return;
  }

  for (const task of tasks) {
    const row = document.createElement("a");
    row.className = "task-row";
    row.href = taskHref(task);

    const main = document.createElement("div");
    main.className = "task-main";
    main.append(statusPill(task.status));
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = task.title || task.taskId;
    const request = document.createElement("div");
    request.className = "task-request";
    request.textContent = task.request || "";
    main.append(title, request);

    const step = document.createElement("div");
    step.className = "task-step";
    const stepName = document.createElement("strong");
    stepName.textContent = task.currentStep || "unknown";
    const message = document.createElement("span");
    message.textContent = task.statusMessage || "No status message";
    step.append(stepName, message);

    const time = document.createElement("div");
    time.className = "task-time";
    const updated = document.createElement("strong");
    updated.textContent = formatAge(task.updatedAt);
    const created = document.createElement("span");
    created.textContent = "created " + formatDate(task.createdAt);
    time.append(updated, created);

    const result = document.createElement("div");
    result.className = "task-pr";
    if (task.prUrl) {
      const pr = document.createElement("span");
      pr.className = "button";
      pr.textContent = task.draft ? "Draft PR" : "PR";
      result.append(pr);
    } else {
      result.textContent = task.error || "pending";
    }

    row.append(main, step, time, result);
    tasksEl.append(row);
  }
}

function filteredTasks() {
  return state.tasks.filter((task) => {
    if (state.filter === "active" && !isActiveTaskStatus(task.status)) return false;
    if (state.filter === "done" && task.status !== "succeeded") return false;
    if (state.filter === "attention" && !isAttentionStatus(task.status)) return false;
    if (!state.query) return true;
    const haystack = [task.taskId, task.title, task.request, task.currentStep, task.statusMessage, task.prUrl]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.query);
  });
}

function metric(label, value, sub) {
  const card = document.createElement("article");
  card.className = "metric-card";
  const labelEl = document.createElement("div");
  labelEl.className = "metric-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "metric-value large";
  valueEl.textContent = String(value);
  const subEl = document.createElement("div");
  subEl.className = "metric-sub";
  subEl.textContent = sub;
  card.append(labelEl, valueEl, subEl);
  return card;
}

function taskHref(task) {
  return "/tasks/" + encodeURIComponent(task.taskId);
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill " + statusTone(status);
  pill.textContent = statusLabel(status);
  return pill;
}

function statusLabel(status) {
  return status || "unknown";
}

function statusTone(status) {
  if (status === "queued" || status === "running") return "tone-active";
  if (status === "succeeded") return "tone-success";
  if (isAttentionStatus(status)) return "tone-danger";
  return "tone-neutral";
}

function isActiveTaskStatus(status) {
  return status === "queued" || status === "running";
}

function isAttentionStatus(status) {
  return status === "failed" || status === "cancelled" || status === "no_changes";
}

function formatAge(value) {
  if (!value) return "unknown";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + "s ago";
  if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
  return Math.round(ms / 86400000) + "d ago";
}

function formatTime(value) {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString();
}
`;
}

function taskTerminalScript() {
  return String.raw`
const taskId = window.AGENT_TASK_ID;
const titleEl = document.getElementById("title");
const titleMetaEl = document.getElementById("titleMeta");
const requestTextEl = document.getElementById("requestText");
const overviewEl = document.getElementById("overview");
const terminalEl = document.getElementById("terminal");
const terminalStatusEl = document.getElementById("terminalStatus");
const timelineEl = document.getElementById("timeline");
const sandboxEl = document.getElementById("sandbox");
const commandsEl = document.getElementById("commands");
const refreshEl = document.getElementById("refresh");
const copyLinkEl = document.getElementById("copyLink");
const autoScrollEl = document.getElementById("autoScroll");
const tabEls = Array.from(document.querySelectorAll("[data-panel]"));

let lastTerminalText = "";

refreshEl.addEventListener("click", refresh);
copyLinkEl.addEventListener("click", copyTaskLink);
for (const tab of tabEls) {
  tab.addEventListener("click", () => activatePanel(tab.dataset.panel || "timeline"));
}

refresh();
setInterval(refresh, 2500);

async function refresh() {
  try {
    const response = await fetch("/api/tasks/" + encodeURIComponent(taskId), { cache: "no-store" });
    if (!response.ok) throw new Error(await response.text());
    const snapshot = await response.json();
    renderSnapshot(snapshot);
  } catch (error) {
    terminalStatusEl.textContent = "Load failed";
    terminalEl.textContent = "Failed to load task: " + error.message;
  }
}

function renderSnapshot(snapshot) {
  const task = snapshot.task;
  titleEl.textContent = task.title || task.taskId;
  titleMetaEl.replaceChildren(statusPill(task.status), textNode(" " + task.taskId));
  requestTextEl.textContent = task.request || "";
  renderOverview(snapshot);
  renderTerminal(snapshot);
  renderTimeline(snapshot.events || []);
  renderSandbox(snapshot.runs || []);
  renderCommands(snapshot.commands || []);
}

function renderOverview(snapshot) {
  const task = snapshot.task;
  const runs = snapshot.runs || [];
  const latestRun = runs[runs.length - 1];
  overviewEl.replaceChildren(
    metric("Status", statusLabel(task.status), statusPill(task.status)),
    metric("Step", task.currentStep || "unknown", task.statusMessage || ""),
    metric("Elapsed", elapsed(task), task.completedAt ? "completed " + formatAge(task.completedAt) : "started " + formatAge(task.startedAt || task.createdAt)),
    metric("Pull Request", task.prUrl ? "opened" : "not opened", task.prUrl ? link(task.prUrl, task.draft ? "Draft PR" : "Open PR") : null),
    metric("Sandbox", latestRun?.backendJobName || "pending", latestRun?.status || "")
  );
}

function metric(label, value, replacement) {
  const card = document.createElement("article");
  card.className = "metric-card";
  const labelEl = document.createElement("div");
  labelEl.className = "metric-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.className = "metric-value";
  if (replacement && typeof replacement !== "string") valueEl.append(replacement);
  else valueEl.textContent = value;
  const subEl = document.createElement("div");
  subEl.className = "metric-sub";
  if (typeof replacement === "string") subEl.textContent = replacement;
  card.append(labelEl, valueEl, subEl);
  return card;
}

function renderTerminal(snapshot) {
  const text = terminalText(snapshot);
  const shouldStickToBottom = autoScrollEl.checked && terminalEl.scrollTop + terminalEl.clientHeight >= terminalEl.scrollHeight - 24;
  if (text !== lastTerminalText) {
    terminalEl.textContent = text;
    lastTerminalText = text;
    if (shouldStickToBottom || autoScrollEl.checked) terminalEl.scrollTop = terminalEl.scrollHeight;
  }
  const task = snapshot.task;
  terminalStatusEl.textContent = [
    task.currentStep ? "step " + task.currentStep : null,
    task.statusMessage || null,
    "updated " + formatTime(new Date())
  ].filter(Boolean).join(" | ");
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
    if (command.outputTail) lines.push(command.outputTail.trimEnd());
    if (command.errorTail) lines.push(command.errorTail.trimEnd());
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
    lines.push("No command output recorded yet.");
  }
  return lines.join("\n");
}

function renderTimeline(events) {
  timelineEl.replaceChildren();
  if (!events.length) {
    timelineEl.append(emptyItem("No task events yet."));
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

function renderSandbox(runs) {
  sandboxEl.replaceChildren();
  if (!runs.length) {
    sandboxEl.append(emptyCard("No sandbox run has been recorded yet."));
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
    card.append(detail("Started", formatDate(run.startedAt)));
    sandboxEl.append(card);
  }
}

function renderCommands(commands) {
  commandsEl.replaceChildren();
  if (!commands.length) {
    commandsEl.append(emptyCard("No completed commands yet."));
    return;
  }
  for (const command of commands) {
    const card = document.createElement("div");
    card.className = "command-card";
    const meta = document.createElement("div");
    meta.className = "command-meta";
    meta.textContent = [command.step, "exit " + nullish(command.exitCode, "?"), formatDuration(command.durationMs)].filter(Boolean).join(" | ");
    const title = document.createElement("div");
    title.className = "command-title";
    title.textContent = command.command || command.step;
    card.append(meta, title);
    commandsEl.append(card);
  }
}

function activatePanel(name) {
  for (const tab of tabEls) tab.classList.toggle("active", tab.dataset.panel === name);
  for (const panel of document.querySelectorAll(".tab-panel")) panel.classList.remove("active");
  document.getElementById(name + "Panel")?.classList.add("active");
  localStorage.setItem("agentTaskPanel", name);
}

activatePanel(localStorage.getItem("agentTaskPanel") || "timeline");

async function copyTaskLink() {
  const href = location.origin + "/tasks/" + encodeURIComponent(taskId);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(href).catch(() => undefined);
  }
  copyLinkEl.textContent = "Copied";
  setTimeout(() => {
    copyLinkEl.textContent = "Copy Link";
  }, 1200);
}

function latestLiveOutput(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const metadata = event.metadata || {};
    if (metadata.stdoutTail || metadata.stderrTail) return event;
  }
  return null;
}

function statusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill " + statusTone(status);
  pill.textContent = statusLabel(status);
  return pill;
}

function statusLabel(status) {
  return status || "unknown";
}

function statusTone(status) {
  if (status === "queued" || status === "running") return "tone-active";
  if (status === "succeeded") return "tone-success";
  if (status === "failed" || status === "cancelled" || status === "no_changes") return "tone-danger";
  return "tone-neutral";
}

function isActiveTaskStatus(status) {
  return status === "queued" || status === "running";
}

function elapsed(task) {
  const start = new Date(task.startedAt || task.createdAt).getTime();
  const end = task.completedAt ? new Date(task.completedAt).getTime() : Date.now();
  return formatDuration(Math.max(0, end - start));
}

function detail(label, value) {
  const wrapper = document.createElement("div");
  const labelEl = document.createElement("div");
  labelEl.className = "detail-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("div");
  valueEl.textContent = value || "unknown";
  wrapper.append(labelEl, valueEl);
  return wrapper;
}

function emptyItem(text) {
  const item = document.createElement("li");
  item.className = "timeline-item";
  item.textContent = text;
  return item;
}

function emptyCard(text) {
  const card = document.createElement("div");
  card.className = "detail-card";
  card.textContent = text;
  return card;
}

function link(href, label) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  return anchor;
}

function textNode(value) {
  return document.createTextNode(value);
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
  const value = Number(ms);
  if (!Number.isFinite(value)) return "unknown";
  if (value < 60000) return (value / 1000).toFixed(3) + "s";
  return Math.floor(value / 60000) + "m " + Math.round((value % 60000) / 1000) + "s";
}

function formatAge(value) {
  if (!value) return "unknown";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + "s ago";
  if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
  return Math.round(ms / 86400000) + "d ago";
}

function formatTime(value) {
  return value.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(value) {
  if (!value) return "unknown";
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
