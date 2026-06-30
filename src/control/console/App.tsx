import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, Clock3, Download, ExternalLink, FileText, RefreshCw, Search, TerminalSquare, Wrench } from "lucide-react";
import { Button, Copy, Status, Tabs, Tag } from "regen-ui";
import { fetchArtifact, fetchRuns, fetchRunSnapshot, subscribeToRun } from "./api.js";
import type { RunArtifact, RunEvent, RunKind, RunSnapshot, RunStatus, RunSummary, TerminalEntry } from "./types.js";

type StatusFilter = "all" | "active" | "done" | "attention";
type DetailTab = "overview" | "timeline" | "calls" | "terminal" | "artifacts" | "raw";
type TerminalStream = TerminalEntry["stream"];

const detailTabs = [
  { id: "overview", label: "Overview", icon: <Activity /> },
  { id: "timeline", label: "Timeline", icon: <Clock3 /> },
  { id: "calls", label: "Calls", icon: <Wrench /> },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare /> },
  { id: "artifacts", label: "Artifacts", icon: <FileText /> },
  { id: "raw", label: "Raw", icon: <FileText /> }
] as const;

const terminalStreamLabels: Record<TerminalStream, string> = {
  command: "Commands",
  stdout: "stdout",
  stderr: "stderr",
  exit: "Exits"
};

export function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(() => runIdFromLocation());
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<RunKind | "all">("all");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [terminalQuery, setTerminalQuery] = useState("");

  const loadRuns = async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const nextRuns = await fetchRuns();
      setRuns(nextRuns);
      if (!selectedRunId && nextRuns[0]) selectRun(nextRuns[0].runId, false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingRuns(false);
    }
  };

  useEffect(() => {
    void loadRuns();
    const interval = setInterval(() => void loadRuns(), 10_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedRunId) return;
    setLoadingSnapshot(true);
    setError(null);
    let disposed = false;
    fetchRunSnapshot(selectedRunId)
      .then((nextSnapshot) => {
        if (!disposed) setSnapshot(nextSnapshot);
      })
      .catch((loadError) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoadingSnapshot(false);
      });
    const unsubscribe = subscribeToRun(
      selectedRunId,
      (nextSnapshot) => {
        if (!disposed) setSnapshot(nextSnapshot);
      },
      (streamError) => {
        if (!disposed) setError(streamError.message);
      }
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [selectedRunId]);

  const filteredRuns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (kind !== "all" && run.kind !== kind) return false;
      if (filter === "active" && isTerminal(run.status)) return false;
      if (filter === "done" && !isTerminal(run.status)) return false;
      if (filter === "attention" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "no_changes") return false;
      if (!normalizedQuery) return true;
      return [run.runId, run.traceId, run.title, run.summary, run.requester, run.currentStep, run.kind, run.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [runs, filter, kind, query]);

  const selectedRun = snapshot?.run ?? runs.find((run) => run.runId === selectedRunId) ?? null;
  const summary = summarizeRuns(runs);

  function selectRun(runId: string, push = true) {
    setSelectedRunId(runId);
    if (push) window.history.pushState(null, "", `${runsRoutePrefix()}/${encodeURIComponent(runId)}`);
  }

  return (
    <main className="run-console">
      <aside className="run-sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Agent Ops</p>
            <h1>Runs</h1>
          </div>
          <Button.Icon title="Refresh runs" variant="surface" onClick={() => void loadRuns()}>
            <RefreshCw />
          </Button.Icon>
        </header>

        <section className="summary-strip" aria-label="Run summary">
          <Metric label="Active" value={summary.active} />
          <Metric label="Failed" value={summary.failed} tone={summary.failed > 0 ? "bad" : "normal"} />
          <Metric label="Code" value={summary.codegen} />
        </section>

        <label className="search-field">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search runs, traces, users" />
        </label>

        <div className="filter-row" aria-label="Run status filters">
          {(["all", "active", "done", "attention"] as const).map((value) => (
            <button key={value} className={filter === value ? "filter active" : "filter"} type="button" onClick={() => setFilter(value)}>
              {value}
            </button>
          ))}
        </div>

        <select className="kind-select" value={kind} onChange={(event) => setKind(event.target.value as RunKind | "all")} aria-label="Run kind">
          <option value="all">All kinds</option>
          <option value="codegen">Codegen</option>
          <option value="discord">Discord</option>
          <option value="crawl">Crawl</option>
          <option value="embedding">Embedding</option>
          <option value="prompt">Prompt</option>
          <option value="workflow">Workflow</option>
          <option value="ops">Ops</option>
        </select>

        <section className="run-list" aria-live="polite">
          {loadingRuns && runs.length === 0 ? (
            <Loading label="Loading runs" />
          ) : filteredRuns.length === 0 ? (
            <Empty label="No runs match" />
          ) : (
            filteredRuns.map((run) => <RunListItem key={run.runId} run={run} selected={run.runId === selectedRunId} onSelect={() => selectRun(run.runId)} />)
          )}
        </section>
      </aside>

      <section className="run-workspace">
        {error && (
          <div className="notice bad">
            <AlertCircle />
            <span>{error}</span>
          </div>
        )}
        {!selectedRun ? (
          <Empty label="Pick a run to inspect" />
        ) : (
          <>
            <RunHeader run={selectedRun} loading={loadingSnapshot} />
            {snapshot ? (
              <>
                <Tabs active={tab} aria-label="Run detail sections" onChange={setTab} tabs={detailTabs} />
                {tab === "overview" && <Overview snapshot={snapshot} />}
                {tab === "timeline" && <Timeline events={snapshot.events} />}
                {tab === "calls" && <Calls events={snapshot.events} />}
                {tab === "terminal" && <TerminalView terminal={snapshot.terminal} query={terminalQuery} onQueryChange={setTerminalQuery} />}
                {tab === "artifacts" && <Artifacts runId={snapshot.run.runId} artifacts={snapshot.artifacts} />}
                {tab === "raw" && <Raw snapshot={snapshot} />}
              </>
            ) : (
              <Loading label="Loading run snapshot" />
            )}
          </>
        )}
      </section>
    </main>
  );
}

function RunHeader({ run, loading }: { run: RunSummary; loading: boolean }) {
  const prUrl = typeof run.links.pullRequest === "string" ? run.links.pullRequest : null;
  const discordUrl = typeof run.links.discordMessage === "string" ? run.links.discordMessage : null;
  return (
    <header className="run-header">
      <div className="title-stack">
        <div className="tag-row">
          <StatusTag status={run.status} />
          <Tag intent="neutral">{run.kind}</Tag>
          {loading && <Tag dot intent="info">syncing</Tag>}
        </div>
        <h2>{run.title}</h2>
        <p>{run.summary ?? run.runId}</p>
      </div>
      <div className="header-actions">
        <Copy value={run.runId} title="Copy run id" />
        {prUrl && <Button.Text render={<a href={prUrl} target="_blank" rel="noreferrer" />} suffix={<ExternalLink />}>PR</Button.Text>}
        {discordUrl && <Button.Text render={<a href={discordUrl} target="_blank" rel="noreferrer" />} suffix={<ExternalLink />}>Discord</Button.Text>}
      </div>
    </header>
  );
}

function Overview({ snapshot }: { snapshot: RunSnapshot }) {
  const maxDuration = Math.max(1, ...snapshot.spans.map((span) => span.durationMs ?? 0));
  return (
    <div className="overview-grid">
      <section className="panel">
        <h3>What Happened</h3>
        <div className="diagnostics">
          {snapshot.diagnostics.length ? snapshot.diagnostics.map((item) => <p key={item}>{item}</p>) : <p>No diagnostics yet.</p>}
        </div>
      </section>
      <section className="panel metrics-panel">
        <Metric label="Duration" value={formatDuration(snapshot.run.durationMs)} />
        <Metric label="Events" value={snapshot.events.length} />
        <Metric label="Artifacts" value={snapshot.artifacts.length} />
        <Metric label="Terminal" value={`${snapshot.terminal.lineCount} lines`} />
      </section>
      <section className="panel wide">
        <h3>Critical Path</h3>
        <div className="waterfall">
          {snapshot.spans.length === 0 ? (
            <Empty label="No spans recorded yet" />
          ) : (
            snapshot.spans.map((span) => (
              <div className="waterfall-row" key={span.id}>
                <div className="waterfall-label">
                  <span>{span.name}</span>
                  <small>{formatDuration(span.durationMs)}</small>
                </div>
                <div className="waterfall-track">
                  <div className={`waterfall-bar ${span.status}`} style={{ width: `${Math.max(4, ((span.durationMs ?? 0) / maxDuration) * 100)}%` }} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function Timeline({ events }: { events: RunEvent[] }) {
  return (
    <section className="panel">
      <h3>Timeline</h3>
      <ol className="timeline">
        {events.map((event) => (
          <li key={event.id} className={`timeline-event ${event.level}`}>
            <div className="timeline-dot" />
            <div>
              <div className="timeline-title">
                <span>{event.name}</span>
                <Tag intent={intentForLevel(event.level)}>{event.source}</Tag>
                {event.durationMs != null && <small>{formatDuration(event.durationMs)}</small>}
              </div>
              <p>{event.summary ?? "No summary"}</p>
              <small>{formatDate(event.createdAt)}</small>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Calls({ events }: { events: RunEvent[] }) {
  const calls = events.filter((event) => event.source === "tool" || /model|openrouter|chat|embed|image|tool/i.test(event.name));
  return (
    <section className="panel">
      <h3>Model And Tool Calls</h3>
      {calls.length === 0 ? (
        <Empty label="No model or tool calls recorded yet" />
      ) : (
        <div className="call-list">
          {calls.map((event) => (
            <article key={event.id} className={`call-item ${event.level}`}>
              <div className="call-heading">
                <strong>{event.name}</strong>
                <Tag intent={intentForLevel(event.level)}>{event.source}</Tag>
                {event.durationMs != null && <small>{formatDuration(event.durationMs)}</small>}
              </div>
              <p>{event.summary ?? "No summary"}</p>
              <details>
                <summary>Metadata</summary>
                <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
              </details>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function TerminalView({
  terminal,
  query,
  onQueryChange
}: {
  terminal: RunSnapshot["terminal"];
  query: string;
  onQueryChange: (value: string) => void;
}) {
  const entries = terminal.entries.length > 0 ? terminal.entries : legacyTerminalEntries(terminal.content);
  const [step, setStep] = useState("all");
  const [streams, setStreams] = useState<Record<TerminalStream, boolean>>({
    command: true,
    stdout: true,
    stderr: true,
    exit: true
  });
  const steps = useMemo(() => uniqueStrings(entries.map((entry) => entry.step)).sort(), [entries]);

  useEffect(() => {
    if (step !== "all" && !steps.includes(step)) setStep("all");
  }, [step, steps]);

  const normalizedQuery = query.trim().toLowerCase();
  const visible = entries.filter((entry) => {
    if (!streams[entry.stream]) return false;
    if (step !== "all" && entry.step !== step) return false;
    if (!normalizedQuery) return true;
    return [entry.content, entry.step, entry.command, entry.stream].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery));
  });
  const content = visible.map((entry) => entry.content).join("\n\n");
  const download = () => downloadText("run-terminal.log", content);

  return (
    <section className="panel terminal-panel">
      <div className="panel-heading">
        <h3>Terminal</h3>
        <div className="terminal-actions">
          <Copy value={content} title="Copy visible terminal output" />
          <Button.Icon title="Download visible terminal output" variant="surface" onClick={download}>
            <Download />
          </Button.Icon>
        </div>
      </div>
      <div className="terminal-controls">
        <label className="terminal-search">
          <Search />
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search terminal output" />
        </label>
        <select className="terminal-source" value={step} onChange={(event) => setStep(event.target.value)} aria-label="Terminal command filter">
          <option value="all">All commands</option>
          {steps.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        <div className="stream-toggle-row" aria-label="Terminal stream filters">
          {(Object.keys(terminalStreamLabels) as TerminalStream[]).map((stream) => (
            <label key={stream} className={streams[stream] ? "stream-toggle active" : "stream-toggle"}>
              <input
                type="checkbox"
                checked={streams[stream]}
                onChange={(event) => setStreams((current) => ({ ...current, [stream]: event.target.checked }))}
              />
              {terminalStreamLabels[stream]}
            </label>
          ))}
        </div>
      </div>
      {content ? <pre className="terminal-output">{content}</pre> : <Empty label="No terminal output matches these filters" />}
    </section>
  );
}

function Artifacts({ runId, artifacts }: { runId: string; artifacts: RunArtifact[] }) {
  const [selected, setSelected] = useState<RunArtifact | null>(artifacts[0] ?? null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setSelected(artifacts[0] ?? null);
  }, [artifacts]);

  useEffect(() => {
    if (!selected) {
      setContent("");
      return;
    }
    setLoading(true);
    fetchArtifact(runId, selected.artifactId)
      .then(setContent)
      .catch((error) => setContent(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false));
  }, [runId, selected]);

  return (
    <section className="artifact-layout">
      <aside className="panel artifact-list">
        <h3>Artifacts</h3>
        {artifacts.length === 0 ? (
          <Empty label="No artifacts yet" />
        ) : (
          artifacts.map((artifact) => (
            <button key={artifact.artifactId} className={selected?.artifactId === artifact.artifactId ? "artifact-item active" : "artifact-item"} onClick={() => setSelected(artifact)} type="button">
              <span>{artifact.name}</span>
              <small>{artifact.kind} · {formatBytes(artifact.sizeBytes)}</small>
            </button>
          ))
        )}
      </aside>
      <section className="panel artifact-content">
        <div className="panel-heading">
          <h3>{selected?.name ?? "Artifact"}</h3>
          {selected && <Copy value={content || selected.preview} title="Copy artifact" />}
        </div>
        {loading ? <Loading label="Loading artifact" /> : <pre>{content || selected?.preview || ""}</pre>}
      </section>
    </section>
  );
}

function Raw({ snapshot }: { snapshot: RunSnapshot }) {
  return (
    <section className="panel terminal-panel">
      <h3>Raw Snapshot</h3>
      <pre className="terminal-output">{JSON.stringify(snapshot, null, 2)}</pre>
    </section>
  );
}

function RunListItem({ run, selected, onSelect }: { run: RunSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button className={selected ? "run-item selected" : "run-item"} onClick={onSelect} type="button">
      <div className="run-item-top">
        <StatusTag status={run.status} />
        <span>{run.kind}</span>
        <small>{formatRelative(run.updatedAt)}</small>
      </div>
      <strong>{run.title}</strong>
      <p>{run.summary ?? run.currentStep ?? run.runId}</p>
      <div className="run-item-bottom">
        <span>{run.requester ?? run.source}</span>
        {run.bottleneck && <span>{run.bottleneck.name} · {formatDuration(run.bottleneck.durationMs)}</span>}
      </div>
    </button>
  );
}

function StatusTag({ status }: { status: RunStatus }) {
  const intent = status === "succeeded" ? "positive" : status === "failed" || status === "cancelled" ? "negative" : status === "no_changes" ? "warning" : "accent";
  return <Tag dot intent={intent}>{status}</Tag>;
}

function Metric({ label, value, tone = "normal" }: { label: string; value: string | number; tone?: "normal" | "bad" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="state">
      <Status type="loading" />
      <span>{label}</span>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return (
    <div className="state empty">
      <Status type="info" />
      <span>{label}</span>
    </div>
  );
}

function summarizeRuns(runs: RunSummary[]) {
  return {
    active: runs.filter((run) => !isTerminal(run.status)).length,
    failed: runs.filter((run) => run.status === "failed").length,
    codegen: runs.filter((run) => run.kind === "codegen").length
  };
}

function legacyTerminalEntries(content: string): TerminalEntry[] {
  if (!content) return [];
  return [
    {
      id: "legacy-terminal",
      source: "command",
      stream: "stdout",
      step: "legacy",
      command: null,
      createdAt: new Date().toISOString(),
      content
    }
  ];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function runIdFromLocation() {
  const match = window.location.pathname.match(/^\/(?:console\/)?runs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function runsRoutePrefix() {
  return window.location.pathname.startsWith("/console/") ? "/console/runs" : "/runs";
}

function isTerminal(status: RunStatus) {
  return status === "succeeded" || status === "failed" || status === "no_changes" || status === "cancelled";
}

function intentForLevel(level: RunEvent["level"]) {
  if (level === "error") return "negative";
  if (level === "warn") return "warning";
  if (level === "debug") return "neutral";
  return "info";
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "live";
  if (value < 1000) return `${value}ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatRelative(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
