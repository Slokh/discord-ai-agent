export function taskListScript() {
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

export function taskTerminalScript() {
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
