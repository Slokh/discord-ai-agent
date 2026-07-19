import { taskListScript, taskTerminalScript } from "./taskTerminalScripts.js";

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
    `,
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
    `,
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
