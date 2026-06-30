import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  Filter,
  Link2,
  MessageSquare,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TerminalSquare,
  Wrench,
  XCircle
} from "lucide-react";
import { Button, Copy, Status, Tabs, Tag } from "regen-ui";
import { fetchArtifact, fetchRuns, fetchRunSnapshot, subscribeToRun } from "./api.js";
import type { EventLevel, RunArtifact, RunEvent, RunKind, RunSnapshot, RunStatus, RunSummary, TerminalEntry } from "./types.js";

type StatusFilter = "all" | "active" | "done" | "attention";
type DetailTab = "overview" | "timeline" | "calls" | "terminal" | "artifacts" | "raw";
type TerminalStream = TerminalEntry["stream"];
type HistoryMode = "push" | "replace";

type ConsoleUrlState = {
  runId: string;
  tab: DetailTab;
  filter: StatusFilter;
  kind: RunKind | "all";
  query: string;
  includeEmbeddings: boolean;
};

const detailTabs = [
  { id: "overview", label: "Overview", icon: <Activity /> },
  { id: "timeline", label: "Timeline", icon: <Clock3 /> },
  { id: "calls", label: "Calls", icon: <Wrench /> },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare /> },
  { id: "artifacts", label: "Artifacts", icon: <FileText /> },
  { id: "raw", label: "Raw", icon: <FileText /> }
] as const;

const statusFilters = ["all", "active", "done", "attention"] as const;
const runKinds = ["all", "codegen", "discord", "crawl", "embedding", "prompt", "workflow", "ops"] as const;
const managedSearchParams = new Set(["tab", "status", "filter", "kind", "q", "embeddings", "includeEmbeddings"]);

const terminalStreamLabels: Record<TerminalStream, string> = {
  command: "Commands",
  stdout: "stdout",
  stderr: "stderr",
  exit: "Exits"
};

export function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState(() => readConsoleUrlState().runId);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>(() => readConsoleUrlState().filter);
  const [kind, setKind] = useState<RunKind | "all">(() => readConsoleUrlState().kind);
  const [query, setQuery] = useState(() => readConsoleUrlState().query);
  const [tab, setTab] = useState<DetailTab>(() => readConsoleUrlState().tab);
  const [includeEmbeddings, setIncludeEmbeddings] = useState(() => readConsoleUrlState().includeEmbeddings);
  const [terminalQuery, setTerminalQuery] = useState("");

  const currentUrlState = useCallback(
    (): ConsoleUrlState => ({ runId: selectedRunId, tab, filter, kind, query, includeEmbeddings }),
    [selectedRunId, tab, filter, kind, query, includeEmbeddings]
  );

  const applyConsoleState = useCallback((next: ConsoleUrlState) => {
    setSelectedRunId(next.runId);
    setTab(next.tab);
    setFilter(next.filter);
    setKind(next.kind);
    setQuery(next.query);
    setIncludeEmbeddings(next.includeEmbeddings);
  }, []);

  const updateConsoleState = useCallback(
    (patch: Partial<ConsoleUrlState>, mode: HistoryMode = "push") => {
      const next = normalizeConsoleUrlState({ ...currentUrlState(), ...patch });
      applyConsoleState(next);
      writeConsoleUrlState(next, mode);
    },
    [applyConsoleState, currentUrlState]
  );

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const nextRuns = await fetchRuns({ includeEmbeddings });
      setRuns(nextRuns);
      if (!selectedRunId && nextRuns[0]) {
        updateConsoleState({ runId: nextRuns[0].runId }, "replace");
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingRuns(false);
    }
  }, [includeEmbeddings, selectedRunId, updateConsoleState]);

  useEffect(() => {
    const onPopState = () => applyConsoleState(readConsoleUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyConsoleState]);

  useEffect(() => {
    void loadRuns();
    const interval = setInterval(() => void loadRuns(), 10_000);
    return () => clearInterval(interval);
  }, [loadRuns]);

  useEffect(() => {
    if (!selectedRunId) {
      setSnapshot(null);
      return;
    }
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
      if (!includeEmbeddings && run.kind === "embedding") return false;
      if (kind !== "all" && run.kind !== kind) return false;
      if (filter === "active" && isTerminal(run.status)) return false;
      if (filter === "done" && !isTerminal(run.status)) return false;
      if (filter === "attention" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "no_changes") return false;
      if (!normalizedQuery) return true;
      return [run.runId, run.traceId, run.title, run.summary, run.requester, run.currentStep, run.kind, run.status]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [runs, filter, includeEmbeddings, kind, query]);

  const selectedRun = snapshot?.run ?? runs.find((run) => run.runId === selectedRunId) ?? null;
  const summary = summarizeRuns(runs, includeEmbeddings);

  function selectRun(runId: string) {
    updateConsoleState({ runId });
  }

  function changeKind(nextKind: RunKind | "all") {
    updateConsoleState({ kind: nextKind, includeEmbeddings: nextKind === "embedding" ? true : includeEmbeddings });
  }

  function changeIncludeEmbeddings(nextIncludeEmbeddings: boolean) {
    updateConsoleState({
      includeEmbeddings: nextIncludeEmbeddings,
      kind: !nextIncludeEmbeddings && kind === "embedding" ? "all" : kind
    });
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
          <input
            value={query}
            onChange={(event) => updateConsoleState({ query: event.target.value }, "replace")}
            placeholder="Search runs, traces, users"
          />
        </label>

        <div className="filter-row" aria-label="Run status filters">
          {statusFilters.map((value) => (
            <button key={value} className={filter === value ? "filter active" : "filter"} type="button" onClick={() => updateConsoleState({ filter: value })}>
              {value}
            </button>
          ))}
        </div>

        <section className="sidebar-settings" aria-label="Run list settings">
          <div className="select-control">
            <Filter />
            <select value={kind} onChange={(event) => changeKind(event.target.value as RunKind | "all")} aria-label="Run kind">
              {runKinds.map((runKind) => (
                <option key={runKind} value={runKind}>
                  {runKind === "all" ? "All kinds" : titleCase(runKind)}
                </option>
              ))}
            </select>
          </div>
          <label className={includeEmbeddings ? "toggle-row active" : "toggle-row"}>
            <input type="checkbox" checked={includeEmbeddings} onChange={(event) => changeIncludeEmbeddings(event.target.checked)} />
            <span>Include embeddings</span>
            {!includeEmbeddings && summary.hiddenEmbeddings > 0 && <small>{summary.hiddenEmbeddings} hidden</small>}
          </label>
        </section>

        <section className="run-list" aria-live="polite">
          {loadingRuns && runs.length === 0 ? (
            <Loading label="Loading runs" />
          ) : filteredRuns.length === 0 ? (
            <Empty label={includeEmbeddings ? "No runs match these filters" : "No runs match. Embedding runs are hidden."} />
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
                <Tabs active={tab} aria-label="Run detail sections" onChange={(nextTab) => updateConsoleState({ tab: nextTab as DetailTab })} tabs={detailTabs} />
                {tab === "overview" && <Overview snapshot={snapshot} />}
                {tab === "timeline" && <Timeline snapshot={snapshot} />}
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
        <p>{run.summary ?? run.currentStep ?? run.runId}</p>
        <div className="run-meta-row">
          <MetaPill icon={<Clock3 />} label="Duration" value={formatDuration(run.durationMs)} />
          <MetaPill icon={<Activity />} label="Updated" value={formatRelative(run.updatedAt)} />
          {run.requester && <MetaPill icon={<Bot />} label="Requester" value={run.requester} />}
          {run.traceId && <MetaPill icon={<Link2 />} label="Trace" value={shortId(run.traceId)} />}
        </div>
      </div>
      <div className="header-actions">
        <Copy value={shareableCurrentUrl()} title="Copy current view link" />
        <Copy value={run.runId} title="Copy run id" />
        {prUrl && (
          <Button.Text render={<a href={prUrl} target="_blank" rel="noreferrer" />} suffix={<ExternalLink />}>
            PR
          </Button.Text>
        )}
        {discordUrl && (
          <Button.Text render={<a href={discordUrl} target="_blank" rel="noreferrer" />} suffix={<ExternalLink />}>
            Discord
          </Button.Text>
        )}
      </div>
    </header>
  );
}

function Overview({ snapshot }: { snapshot: RunSnapshot }) {
  const maxDuration = Math.max(1, ...snapshot.spans.map((span) => span.durationMs ?? 0));
  const slowest = [...snapshot.spans].sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0)).slice(0, 3);
  return (
    <div className="overview-grid">
      <section className="panel insight-panel">
        <div className="panel-title">
          <Activity />
          <h3>What Happened</h3>
        </div>
        <div className="diagnostics">
          {snapshot.diagnostics.length ? snapshot.diagnostics.map((item) => <p key={item}>{item}</p>) : <p>No diagnostics yet. Watch the timeline and calls tabs as events stream in.</p>}
        </div>
      </section>
      <section className="panel metrics-panel">
        <Metric label="Duration" value={formatDuration(snapshot.run.durationMs)} />
        <Metric label="Events" value={snapshot.events.length} />
        <Metric label="Artifacts" value={snapshot.artifacts.length} />
        <Metric label="Terminal" value={`${snapshot.terminal.lineCount} lines`} />
      </section>
      <section className="panel">
        <div className="panel-title">
          <SlidersHorizontal />
          <h3>Run Essentials</h3>
        </div>
        <dl className="facts">
          <Fact label="Status" value={snapshot.run.status} />
          <Fact label="Current step" value={snapshot.run.currentStep ?? "none"} />
          <Fact label="Source" value={snapshot.run.source} />
          <Fact label="Run id" value={snapshot.run.runId} copy />
          {snapshot.run.messageId && <Fact label="Message id" value={snapshot.run.messageId} copy />}
        </dl>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Clock3 />
          <h3>Slowest Phases</h3>
        </div>
        {slowest.length === 0 ? (
          <Empty label="No spans recorded yet" />
        ) : (
          <div className="phase-list">
            {slowest.map((span) => (
              <div key={span.id} className="phase-item">
                <span>{span.name}</span>
                <strong>{formatDuration(span.durationMs)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel wide">
        <div className="panel-title">
          <Clock3 />
          <h3>Critical Path</h3>
        </div>
        <div className="waterfall">
          {snapshot.spans.length === 0 ? (
            <Empty label="No spans recorded yet" />
          ) : (
            snapshot.spans.map((span) => (
              <div className="waterfall-row" key={span.id}>
                <div className="waterfall-label">
                  <span>{span.name}</span>
                  <div>
                    <StatusTag status={span.status} />
                    <small>{formatDuration(span.durationMs)}</small>
                  </div>
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

function Timeline({ snapshot }: { snapshot: RunSnapshot }) {
  const [level, setLevel] = useState<EventLevel | "all">("all");
  const [source, setSource] = useState<RunEvent["source"] | "all">("all");
  const sources = useMemo(() => uniqueStrings(snapshot.events.map((event) => event.source)).sort() as Array<RunEvent["source"]>, [snapshot.events]);
  const events = snapshot.events.filter((event) => {
    if (level !== "all" && event.level !== level) return false;
    if (source !== "all" && event.source !== source) return false;
    return true;
  });

  return (
    <section className="panel detail-panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Clock3 />
          <h3>Timeline</h3>
        </div>
        <div className="mini-controls">
          <select value={level} onChange={(event) => setLevel(event.target.value as EventLevel | "all")} aria-label="Timeline severity filter">
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
            <option value="debug">Debug</option>
          </select>
          <select value={source} onChange={(event) => setSource(event.target.value as RunEvent["source"] | "all")} aria-label="Timeline source filter">
            <option value="all">All sources</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {titleCase(item)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {events.length === 0 ? (
        <Empty label="No events match these filters" />
      ) : (
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.id} className={`timeline-event ${event.level}`}>
              <div className="timeline-rail">
                <div className="timeline-dot" />
              </div>
              <article className="timeline-card">
                <div className="timeline-title">
                  <strong>{humanizeEventName(event.name)}</strong>
                  <Tag intent={intentForLevel(event.level)}>{event.source}</Tag>
                  {event.durationMs != null && <small>{formatDuration(event.durationMs)}</small>}
                </div>
                <p>{event.summary ?? "No summary"}</p>
                <div className="timeline-meta">
                  <span>{formatDate(event.createdAt)}</span>
                  <span>{formatOffset(snapshot.run.startedAt, event.createdAt)}</span>
                </div>
                {Object.keys(event.metadata).length > 0 && (
                  <details>
                    <summary>Metadata</summary>
                    <MetadataPreview metadata={event.metadata} />
                  </details>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Calls({ events }: { events: RunEvent[] }) {
  const [kind, setKind] = useState<"all" | "model" | "tool" | "errors">("all");
  const calls = events
    .map((event) => ({ event, kind: callKind(event) }))
    .filter((item) => item.kind === "model" || item.kind === "tool" || item.event.level === "error")
    .filter((item) => kind === "all" || (kind === "errors" ? item.event.level === "error" : item.kind === kind));
  const counts = {
    model: events.filter((event) => callKind(event) === "model").length,
    tool: events.filter((event) => callKind(event) === "tool").length,
    errors: events.filter((event) => event.level === "error").length
  };

  return (
    <section className="panel detail-panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Wrench />
          <h3>Model and tool calls</h3>
        </div>
        <div className="filter-row compact" aria-label="Call filters">
          {(["all", "model", "tool", "errors"] as const).map((value) => (
            <button key={value} className={kind === value ? "filter active" : "filter"} type="button" onClick={() => setKind(value)}>
              {value === "all" ? "All" : `${titleCase(value)} ${value === "model" || value === "tool" || value === "errors" ? counts[value] : ""}`}
            </button>
          ))}
        </div>
      </div>
      {calls.length === 0 ? (
        <Empty label="No model or tool calls match these filters" />
      ) : (
        <div className="call-list">
          {calls.map(({ event, kind: callType }) => (
            <article key={event.id} className={`call-item ${event.level}`}>
              <div className="call-heading">
                <span className={`call-icon ${callType}`}>{callType === "model" ? <MessageSquare /> : event.level === "error" ? <XCircle /> : <Wrench />}</span>
                <div>
                  <strong>{humanizeEventName(event.name)}</strong>
                  <p>{event.summary ?? "No summary"}</p>
                </div>
                <div className="call-badges">
                  <Tag intent={intentForLevel(event.level)}>{event.source}</Tag>
                  {event.durationMs != null && <small>{formatDuration(event.durationMs)}</small>}
                </div>
              </div>
              {Object.keys(event.metadata).length > 0 && (
                <details>
                  <summary>Inspect metadata</summary>
                  <MetadataPreview metadata={event.metadata} />
                </details>
              )}
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
    <section className="panel terminal-panel detail-panel">
      <div className="panel-heading">
        <div className="panel-title">
          <TerminalSquare />
          <h3>Terminal</h3>
        </div>
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
            <option key={item} value={item}>
              {item}
            </option>
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
  const [selectedId, setSelectedId] = useState(artifacts[0]?.artifactId ?? "");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const selected = artifacts.find((artifact) => artifact.artifactId === selectedId) ?? artifacts[0] ?? null;

  useEffect(() => {
    if (selectedId && artifacts.some((artifact) => artifact.artifactId === selectedId)) return;
    setSelectedId(artifacts[0]?.artifactId ?? "");
  }, [artifacts, selectedId]);

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
        <div className="panel-title">
          <FileText />
          <h3>Artifacts</h3>
        </div>
        {artifacts.length === 0 ? (
          <Empty label="No artifacts yet" />
        ) : (
          artifacts.map((artifact) => (
            <button
              key={artifact.artifactId}
              className={selected?.artifactId === artifact.artifactId ? "artifact-item active" : "artifact-item"}
              onClick={() => setSelectedId(artifact.artifactId)}
              type="button"
            >
              <span>{artifact.name}</span>
              <small>
                {artifact.kind} - {formatBytes(artifact.sizeBytes)}
              </small>
            </button>
          ))
        )}
      </aside>
      <section className="panel artifact-content">
        <div className="panel-heading">
          <div className="panel-title">
            <FileText />
            <h3>{selected?.name ?? "Artifact"}</h3>
          </div>
          {selected && <Copy value={content || selected.preview} title="Copy artifact" />}
        </div>
        {loading ? <Loading label="Loading artifact" /> : <pre>{content || selected?.preview || ""}</pre>}
      </section>
    </section>
  );
}

function Raw({ snapshot }: { snapshot: RunSnapshot }) {
  return (
    <section className="panel terminal-panel detail-panel">
      <div className="panel-title">
        <FileText />
        <h3>Raw Snapshot</h3>
      </div>
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
        {run.bottleneck ? <span>{run.bottleneck.name} - {formatDuration(run.bottleneck.durationMs)}</span> : <span>{formatDuration(run.durationMs)}</span>}
      </div>
    </button>
  );
}

function StatusTag({ status }: { status: RunStatus }) {
  const intent = status === "succeeded" ? "positive" : status === "failed" || status === "cancelled" ? "negative" : status === "no_changes" ? "warning" : "accent";
  return (
    <Tag dot intent={intent}>
      {status}
    </Tag>
  );
}

function Metric({ label, value, tone = "normal" }: { label: string; value: string | number; tone?: "normal" | "bad" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetaPill({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <span className="meta-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function Fact({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        {copy && <Copy value={value} title={`Copy ${label}`} />}
      </dd>
    </div>
  );
}

function MetadataPreview({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata).slice(0, 8);
  if (entries.length === 0) return <p className="muted">No metadata.</p>;
  return (
    <dl className="metadata-grid">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>{metadataValue(value)}</dd>
        </div>
      ))}
    </dl>
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

function summarizeRuns(runs: RunSummary[], includeEmbeddings: boolean) {
  const visible = includeEmbeddings ? runs : runs.filter((run) => run.kind !== "embedding");
  return {
    active: visible.filter((run) => !isTerminal(run.status)).length,
    failed: visible.filter((run) => run.status === "failed").length,
    codegen: visible.filter((run) => run.kind === "codegen").length,
    hiddenEmbeddings: includeEmbeddings ? 0 : runs.filter((run) => run.kind === "embedding").length
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

function readConsoleUrlState(): ConsoleUrlState {
  const search = new URLSearchParams(window.location.search);
  const kind = parseKind(search.get("kind"));
  return normalizeConsoleUrlState({
    runId: runIdFromLocation(),
    tab: parseTab(search.get("tab")),
    filter: parseStatusFilter(search.get("status") ?? search.get("filter")),
    kind,
    query: search.get("q") ?? "",
    includeEmbeddings: search.get("embeddings") === "1" || search.get("includeEmbeddings") === "1" || kind === "embedding"
  });
}

function normalizeConsoleUrlState(state: ConsoleUrlState): ConsoleUrlState {
  const includeEmbeddings = state.includeEmbeddings || state.kind === "embedding";
  return {
    ...state,
    includeEmbeddings,
    kind: !includeEmbeddings && state.kind === "embedding" ? "all" : state.kind
  };
}

function writeConsoleUrlState(state: ConsoleUrlState, mode: HistoryMode) {
  const params = new URLSearchParams(window.location.search);
  for (const key of managedSearchParams) params.delete(key);
  if (state.tab !== "overview") params.set("tab", state.tab);
  if (state.filter !== "all") params.set("status", state.filter);
  if (state.kind !== "all") params.set("kind", state.kind);
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.includeEmbeddings) params.set("embeddings", "1");
  const path = state.runId ? `${runsRoutePrefix()}/${encodeURIComponent(state.runId)}` : runsRoutePrefix();
  const nextUrl = `${path}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === nextUrl) return;
  if (mode === "replace") window.history.replaceState(null, "", nextUrl);
  else window.history.pushState(null, "", nextUrl);
}

function runIdFromLocation() {
  const match = window.location.pathname.match(/^\/(?:console\/)?runs\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]!) : "";
}

function runsRoutePrefix() {
  return window.location.pathname.startsWith("/console/") ? "/console/runs" : "/runs";
}

function parseTab(value: string | null): DetailTab {
  return detailTabs.some((item) => item.id === value) ? (value as DetailTab) : "overview";
}

function parseStatusFilter(value: string | null): StatusFilter {
  return statusFilters.includes(value as StatusFilter) ? (value as StatusFilter) : "all";
}

function parseKind(value: string | null): RunKind | "all" {
  return runKinds.includes(value as RunKind | "all") ? (value as RunKind | "all") : "all";
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

function callKind(event: RunEvent) {
  if (event.source === "tool" || /tool|discordhistory|discordstats|generateimage|inspect|fetch|search/i.test(event.name)) return "tool";
  if (/model|openrouter|chat|embed|image|completion/i.test(event.name)) return "model";
  return "process";
}

function humanizeEventName(value: string) {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function titleCase(value: string) {
  return value.replace(/^\w/, (letter) => letter.toUpperCase());
}

function metadataValue(value: unknown) {
  if (value == null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function shortId(value: string) {
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-6)}` : value;
}

function shareableCurrentUrl() {
  return window.location.href;
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "live";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
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

function formatOffset(startedAt: string, eventAt: string) {
  const offset = new Date(eventAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(offset) || offset < 0) return "before start";
  return `+${formatDuration(offset)}`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
