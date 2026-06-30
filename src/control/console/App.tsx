import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  Clock3,
  Download,
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
import { fetchArtifact, fetchRuns, fetchRunSnapshot, resolveRunReference, subscribeToRun } from "./api.js";
import type { EventLevel, RunArtifact, RunEvent, RunKind, RunSnapshot, RunSpan, RunStatus, RunSummary, TerminalEntry } from "./types.js";

type StatusFilter = "all" | "active" | "done" | "attention";
type DetailTab = "overview" | "timeline" | "terminal" | "artifacts" | "raw";
type TerminalStream = TerminalEntry["stream"];
type HistoryMode = "push" | "replace";
type LatencyRow = RunSnapshot["spans"][number] & { durationMs: number };
type TimelinePhaseId = "initial" | "setup" | "execution" | "cleanup" | "response";
type TimedRunEvent = { event: RunEvent; gapMs: number | null; offset: string };
type TimelineStepKind = FlowItemKind | "span" | "event";
type TimelineStep = {
  id: string;
  kind: TimelineStepKind;
  title: string;
  summary: string;
  createdAt: string;
  durationMs: number | null;
  gapMs: number | null;
  offset: string;
  source: string;
  status: RunStatus | null;
  level: EventLevel | null;
  metadata: Record<string, unknown>;
  artifact?: RunArtifact;
};
type TimelinePhase = {
  id: TimelinePhaseId;
  label: string;
  description: string;
  steps: TimelineStep[];
  durationMs: number;
  status: RunStatus;
  slowest: { name: string; durationMs: number } | null;
};
type FlowItemKind = "input" | "model" | "tool" | "artifact" | "response" | "error";
type FlowItem = {
  id: string;
  kind: FlowItemKind;
  title: string;
  summary: string;
  createdAt: string;
  durationMs: number | null;
  source: string;
  level: EventLevel | null;
  metadata: Record<string, unknown>;
  artifact?: RunArtifact;
};

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

const phaseDefinitions: Record<TimelinePhaseId, { label: string; description: string }> = {
  initial: { label: "Initial Message", description: "Request intake and user-visible trigger" },
  setup: { label: "Setup", description: "Context, permissions, sandbox, dependencies, and preflight work" },
  execution: { label: "Execution", description: "Model, tool, command, crawl, and embedding work" },
  cleanup: { label: "Cleanup", description: "Verification, persistence, git, PR, and finalization work" },
  response: { label: "Response", description: "Discord edits, replies, failures, and final user-facing output" }
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
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [jumpResolving, setJumpResolving] = useState(false);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);

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
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && key === "k") {
        event.preventDefault();
        setJumpOpen(true);
        setJumpValue("");
        setJumpError(null);
      }
      if (event.key === "Escape") {
        setJumpOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!jumpOpen) return;
    window.setTimeout(() => jumpInputRef.current?.focus(), 0);
  }, [jumpOpen]);

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

  async function jumpToRun(rawQuery = jumpValue) {
    const queryValue = rawQuery.trim();
    if (!queryValue || jumpResolving) return;
    setJumpResolving(true);
    setJumpError(null);
    try {
      const resolution = await resolveRunReference(queryValue);
      setRuns((current) => {
        if (current.some((run) => run.runId === resolution.run.runId)) return current;
        return [resolution.run, ...current];
      });
      updateConsoleState({
        runId: resolution.run.runId,
        includeEmbeddings: includeEmbeddings || resolution.run.kind === "embedding"
      });
      setJumpOpen(false);
      setJumpValue("");
    } catch (resolveError) {
      setJumpError(resolveError instanceof Error ? resolveError.message : String(resolveError));
    } finally {
      setJumpResolving(false);
    }
  }

  function pasteJump(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!pasted.trim()) return;
    event.preventDefault();
    setJumpValue(pasted);
    void jumpToRun(pasted);
  }

  return (
    <>
      <main className="run-console">
        <aside className="run-sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Agent Ops</p>
            <h1>Runs</h1>
          </div>
          <div className="sidebar-actions">
            <Button.Icon
              title="Jump to run (Cmd+K)"
              variant="surface"
              onClick={() => {
                setJumpOpen(true);
                setJumpValue("");
                setJumpError(null);
              }}
            >
              <Search />
            </Button.Icon>
            <Button.Icon title="Refresh runs" variant="surface" onClick={() => void loadRuns()}>
              <RefreshCw />
            </Button.Icon>
          </div>
        </header>

        <section className="summary-strip" aria-label="Run summary">
          <Metric label="Active" value={summary.active} tone={summary.active > 0 ? "info" : "normal"} />
          <Metric label="Failed" value={summary.failed} tone={summary.failed > 0 ? "bad" : "normal"} />
          <Metric label="Code" value={summary.codegen} tone={summary.codegen > 0 ? "good" : "normal"} />
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
                <div className="detail-tabs">
                  <Tabs active={tab} aria-label="Run detail sections" onChange={(nextTab) => updateConsoleState({ tab: nextTab as DetailTab })} tabs={detailTabs} />
                </div>
                {tab === "overview" && <Overview snapshot={snapshot} />}
                {tab === "timeline" && <Timeline snapshot={snapshot} />}
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
      {jumpOpen && (
        <RunJumpPalette
          value={jumpValue}
          resolving={jumpResolving}
          error={jumpError}
          inputRef={jumpInputRef}
          onChange={(value) => {
            setJumpValue(value);
            setJumpError(null);
          }}
          onClose={() => setJumpOpen(false)}
          onPaste={pasteJump}
          onSubmit={() => void jumpToRun()}
        />
      )}
    </>
  );
}

function RunHeader({ run, loading }: { run: RunSummary; loading: boolean }) {
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
          {run.traceId && <MetaPill icon={<Link2 />} label="Trace" value={shortId(run.traceId)} copyValue={run.traceId} />}
        </div>
      </div>
    </header>
  );
}

function RunJumpPalette({
  value,
  resolving,
  error,
  inputRef,
  onChange,
  onClose,
  onPaste,
  onSubmit
}: {
  value: string;
  resolving: boolean;
  error: string | null;
  inputRef: { current: HTMLInputElement | null };
  onChange: (value: string) => void;
  onClose: () => void;
  onPaste: (event: ClipboardEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="jump-overlay" role="presentation" onMouseDown={onClose}>
      <section className="jump-panel" role="dialog" aria-modal="true" aria-label="Jump to run" onMouseDown={(event) => event.stopPropagation()}>
        <div className="jump-input-row">
          <Search />
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
              if (event.key === "Escape") onClose();
            }}
            placeholder="Paste Discord message link or message id"
          />
          {resolving ? <Status type="loading" /> : <kbd>Enter</kbd>}
        </div>
        <div className="jump-help">
          <span>Paste a Discord `/channels/.../.../...` link or raw message id.</span>
          <kbd>Esc</kbd>
        </div>
        {error && (
          <div className="jump-error">
            <AlertCircle />
            <span>{error}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Overview({ snapshot }: { snapshot: RunSnapshot }) {
  const latencyRows = latencyBreakdown(snapshot);
  const totalDuration = latencyTotal(snapshot);
  const slowest = latencyRows[0] ?? null;
  const signalEvents = snapshot.events.filter((event) => event.level === "error" || event.level === "warn").slice(-4).reverse();
  return (
    <div className="overview-grid">
      <section className="panel insight-panel">
        <div className="panel-title">
          <Activity />
          <h3>Summary</h3>
        </div>
        <div className="diagnostics">
          {snapshot.diagnostics.length ? snapshot.diagnostics.map((item) => <p key={item}>{item}</p>) : <p>No diagnostics recorded yet.</p>}
        </div>
      </section>
      <section className="panel metrics-panel">
        <Metric label="Status" value={snapshot.run.status} tone={snapshot.run.status === "failed" ? "bad" : snapshot.run.status === "succeeded" ? "good" : "normal"} />
        <Metric label="Duration" value={formatDuration(snapshot.run.durationMs)} />
        <Metric label="Slowest" value={slowest ? `${slowest.name} (${formatDuration(slowest.durationMs)})` : "none"} tone={slowest ? "info" : "normal"} />
        <Metric label="Events" value={snapshot.events.length} />
      </section>
      <section className="panel wide">
        <div className="panel-title">
          <Clock3 />
          <h3>Latency</h3>
        </div>
        <LatencyBreakdown rows={latencyRows} totalDuration={totalDuration} />
      </section>
      <section className="panel">
        <div className="panel-title">
          <AlertCircle />
          <h3>Signals</h3>
        </div>
        {signalEvents.length === 0 ? (
          <Empty label="No warnings or errors" />
        ) : (
          <div className="signal-list">
            {signalEvents.map((event) => (
              <div key={event.id} className={`signal-item ${event.level}`}>
                <strong>{humanizeEventName(event.name)}</strong>
                <span>{event.summary ?? event.source}</span>
                <small>{formatOffset(snapshot.run.startedAt, event.createdAt)}</small>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <SlidersHorizontal />
          <h3>Details</h3>
        </div>
        <dl className="facts">
          <Fact label="Current step" value={snapshot.run.currentStep ?? "none"} />
          <Fact label="Source" value={snapshot.run.source} />
          <Fact label="Run id" value={snapshot.run.runId} copy />
          {snapshot.run.messageId && <Fact label="Message id" value={snapshot.run.messageId} copy />}
          <Fact label="Artifacts" value={String(snapshot.artifacts.length)} />
          <Fact label="Terminal" value={`${snapshot.terminal.lineCount} lines`} />
        </dl>
      </section>
    </div>
  );
}

function LatencyBreakdown({ rows, totalDuration }: { rows: LatencyRow[]; totalDuration: number }) {
  if (rows.length === 0) return <Empty label="No timed spans recorded yet" />;
  const maxDuration = Math.max(1, ...rows.map((row) => row.durationMs));
  return (
    <div className="latency-table" role="table" aria-label="Latency by run phase">
      <div className="latency-row latency-head" role="row">
        <span>Step</span>
        <span>Duration</span>
        <span>Share</span>
      </div>
      {rows.map((row) => {
        const share = totalDuration > 0 ? row.durationMs / totalDuration : 0;
        return (
          <div className="latency-row" role="row" key={row.id}>
            <div className="latency-step">
              <strong>{row.name}</strong>
              <small>{row.source}</small>
            </div>
            <strong>{formatDuration(row.durationMs)}</strong>
            <div className="latency-share">
              <span>{formatPercent(share)}</span>
              <div className="latency-track">
                <div className={`latency-bar ${row.status}`} style={{ width: `${Math.max(3, (row.durationMs / maxDuration) * 100)}%` }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Timeline({ snapshot }: { snapshot: RunSnapshot }) {
  const [level, setLevel] = useState<EventLevel | "all">("all");
  const [source, setSource] = useState<string>("all");
  const flowItems = useMemo(() => conversationFlow(snapshot), [snapshot]);
  const sources = useMemo(
    () => uniqueStrings([...snapshot.events.map((event) => event.source), ...snapshot.spans.map((span) => span.source), ...flowItems.map((item) => item.source)]).sort(),
    [snapshot.events, snapshot.spans, flowItems]
  );
  const events = snapshot.events.filter((event) => {
    if (level !== "all" && event.level !== level) return false;
    if (source !== "all" && event.source !== source) return false;
    return true;
  });
  const spans = snapshot.spans.filter((span) => {
    if (source !== "all" && span.source !== source) return false;
    if (level === "error") return span.status === "failed" || span.status === "cancelled";
    if (level === "warn") return span.status === "no_changes";
    if (level === "debug") return false;
    return true;
  });
  const flows = flowItems.filter((item) => {
    if (level !== "all" && item.level !== level) return false;
    if (source !== "all" && item.source !== source) return false;
    return true;
  });
  const timelineStartedAt = timelineStart(snapshot.run.startedAt, events, spans, flows);
  const timedEvents = eventsWithTiming(events, timelineStartedAt);
  const phases = timelinePhases({ events: timedEvents, spans, flows, startedAt: timelineStartedAt });

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
          <select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Timeline source filter">
            <option value="all">All sources</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {titleCase(item)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {phases.length === 0 ? (
        <Empty label="No timeline items match these filters" />
      ) : (
        <div className="phase-groups">
          {phases.map((phase) => (
            <details key={phase.id} className={`phase-group ${phase.status}`} open={phase.status === "failed" || phase.status === "running" || phase.id === "execution" || phase.id === "response"}>
              <summary className="phase-summary">
                <div>
                  <strong>{phase.label}</strong>
                  <span>{phase.description}</span>
                </div>
                <div className="time-stack">
                  <strong>{formatDuration(phase.durationMs)}</strong>
                  <small>{phase.steps.length} steps</small>
                  {phase.slowest && <small title={phase.slowest.name}>slowest {formatDuration(phase.slowest.durationMs)}</small>}
                </div>
              </summary>
              <ol className="phase-timeline">
                {phase.steps.map((step) => (
                  <li key={step.id} className={`phase-step ${step.kind} ${step.level ?? step.status ?? ""}`}>
                    <div className="timeline-rail">
                      <div className="timeline-dot" />
                    </div>
                    <article className="timeline-card">
                      <div className="timeline-title">
                        <span className={`timeline-icon ${step.kind}`}>{timelineStepIcon(step.kind)}</span>
                        <div className="timeline-step-main">
                          <strong>{step.title}</strong>
                          <span>{step.source}</span>
                        </div>
                        <div className="time-stack">
                          <strong>{step.offset}</strong>
                          {step.gapMs != null && <small>{formatSignedDuration(step.gapMs)}</small>}
                        </div>
                      </div>
                      <p>{step.summary}</p>
                      <div className="timeline-meta">
                        <span className={`timeline-kind ${step.kind}`}>{timelineStepLabel(step.kind)}</span>
                        <span>{formatDate(step.createdAt)}</span>
                        {step.durationMs != null && <span>took {formatDuration(step.durationMs)}</span>}
                        {step.level && <span className={`level-text ${step.level}`}>{step.level}</span>}
                        {step.status && <span className={`level-text ${step.status}`}>{step.status}</span>}
                        {step.artifact && <span>{formatBytes(step.artifact.sizeBytes)}</span>}
                      </div>
                      {step.artifact && (
                        <div className="flow-artifact-meta">
                          <span>{step.artifact.kind}</span>
                          <span>{step.artifact.contentType}</span>
                          {step.artifact.redacted && <span>redacted</span>}
                        </div>
                      )}
                      {Object.keys(step.metadata).length > 0 && (
                        <details>
                          <summary>Metadata</summary>
                          <MetadataPreview metadata={step.metadata} />
                        </details>
                      )}
                    </article>
                  </li>
                ))}
              </ol>
            </details>
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
    <button className={`run-item status-${run.status} kind-${run.kind}${selected ? " selected" : ""}`} onClick={onSelect} type="button">
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

function Metric({ label, value, tone = "normal" }: { label: string; value: string | number; tone?: "normal" | "bad" | "good" | "info" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MetaPill({ icon, label, value, copyValue }: { icon: ReactNode; label: string; value: string; copyValue?: string }) {
  return (
    <span className="meta-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      {copyValue && <Copy value={copyValue} title={`Copy ${label}`} />}
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
  if (value === "calls") return "timeline";
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

function timelinePhases({ events, spans, flows, startedAt }: { events: TimedRunEvent[]; spans: RunSpan[]; flows: FlowItem[]; startedAt: string }): TimelinePhase[] {
  const buckets = new Map<TimelinePhaseId, TimelineStep[]>();
  const flowEventIds = new Set(flows.map((flow) => flow.id.match(/^event-(.+)$/)?.[1]).filter(Boolean));
  for (const phaseId of Object.keys(phaseDefinitions) as TimelinePhaseId[]) buckets.set(phaseId, []);
  for (const span of spans) {
    if (isEnvelopeSpan(span)) continue;
    buckets.get(phaseForText(span.name, span.source))?.push(timelineStepFromSpan(span, startedAt));
  }
  for (const flow of flows) {
    buckets.get(phaseForText(flow.title, flow.source, flow.summary))?.push(timelineStepFromFlow(flow, startedAt));
  }
  for (const event of events) {
    if (flowEventIds.has(event.event.id)) continue;
    if (isLowSignalTimelineEvent(event.event)) continue;
    if (isDuplicateSpanEvent(event.event, spans)) continue;
    buckets.get(phaseForText(event.event.name, event.event.source, event.event.summary))?.push(timelineStepFromEvent(event));
  }
  return (Object.keys(phaseDefinitions) as TimelinePhaseId[])
    .map((id) => {
      const steps = buckets.get(id)!;
      return buildTimelinePhase(id, steps);
    })
    .filter((phase) => phase.steps.length > 0);
}

function timelineStart(defaultStartedAt: string, events: RunEvent[], spans: RunSpan[], flows: FlowItem[]) {
  const times = [
    defaultStartedAt,
    ...events.map((event) => event.createdAt),
    ...spans.map((span) => span.startedAt),
    ...flows.map((flow) => flow.createdAt)
  ]
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (times.length === 0) return defaultStartedAt;
  return new Date(Math.min(...times)).toISOString();
}

function buildTimelinePhase(id: TimelinePhaseId, steps: TimelineStep[]): TimelinePhase {
  const sortedSteps = withStepGaps(steps);
  const durations = sortedSteps.map((step) => ({ name: step.title, durationMs: step.durationMs ?? 0 })).filter((item) => item.durationMs > 0);
  const durationMs = stepRangeDuration(sortedSteps);
  const slowest = durations.length > 0 ? durations.reduce((current, item) => (item.durationMs > current.durationMs ? item : current), durations[0]!) : null;
  return {
    id,
    label: phaseDefinitions[id].label,
    description: phaseDefinitions[id].description,
    steps: sortedSteps,
    durationMs,
    status: phaseStatus(sortedSteps),
    slowest
  };
}

function timelineStepFromSpan(span: RunSpan, startedAt: string): TimelineStep {
  return {
    id: `span-${span.id}`,
    kind: "span",
    title: span.name,
    summary: spanSummary(span),
    createdAt: span.startedAt,
    durationMs: span.durationMs,
    gapMs: null,
    offset: formatOffset(startedAt, span.startedAt),
    source: span.source,
    status: span.status,
    level: null,
    metadata: span.metadata
  };
}

function timelineStepFromFlow(flow: FlowItem, startedAt: string): TimelineStep {
  return {
    id: flow.id,
    kind: flow.kind,
    title: flow.title,
    summary: flow.summary,
    createdAt: flow.createdAt,
    durationMs: flow.durationMs,
    gapMs: null,
    offset: formatOffset(startedAt, flow.createdAt),
    source: flow.source,
    status: null,
    level: flow.level,
    metadata: flow.metadata,
    artifact: flow.artifact
  };
}

function timelineStepFromEvent({ event, offset }: TimedRunEvent): TimelineStep {
  return {
    id: `event-${event.id}`,
    kind: event.level === "error" ? "error" : "event",
    title: humanizeEventName(event.name),
    summary: event.summary ?? "No summary recorded.",
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    gapMs: null,
    offset,
    source: event.source,
    status: null,
    level: event.level,
    metadata: event.metadata
  };
}

function withStepGaps(steps: TimelineStep[]) {
  const sortedSteps = [...steps].sort((left, right) => {
      const timeDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return timelineStepOrder(left.kind) - timelineStepOrder(right.kind);
    });
  return compactTimelineSteps(sortedSteps)
    .map((step, index, sortedSteps) => {
      const previous = index > 0 ? sortedSteps[index - 1] : null;
      const gapMs = previous ? new Date(step.createdAt).getTime() - new Date(previous.createdAt).getTime() : null;
      return {
        ...step,
        gapMs: gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null
      };
    });
}

function compactTimelineSteps(steps: TimelineStep[]) {
  return steps.filter((step) => {
    if (step.kind !== "span") return true;
    if (step.source !== "command") return true;
    const stepName = normalizedTimelineName(step.title);
    const stepStartedAt = new Date(step.createdAt).getTime();
    return !steps.some((candidate) => {
      if (candidate.id === step.id || candidate.kind !== "span" || candidate.source !== "task") return false;
      if (normalizedTimelineName(candidate.title) !== stepName) return false;
      const candidateStartedAt = new Date(candidate.createdAt).getTime();
      if (!Number.isFinite(stepStartedAt) || !Number.isFinite(candidateStartedAt)) return false;
      if (Math.abs(candidateStartedAt - stepStartedAt) > 1_500) return false;
      return (candidate.durationMs ?? 0) >= (step.durationMs ?? 0);
    });
  });
}

function timelineStepOrder(kind: TimelineStepKind) {
  const order: Record<TimelineStepKind, number> = {
    input: 0,
    event: 1,
    model: 2,
    tool: 3,
    span: 4,
    artifact: 5,
    response: 6,
    error: 7
  };
  return order[kind];
}

function phaseStatus(steps: TimelineStep[]): RunStatus {
  if (steps.some((step) => step.status === "failed" || step.status === "cancelled" || step.level === "error" || step.kind === "error")) return "failed";
  if (steps.some((step) => step.status === "running")) return "running";
  if (steps.some((step) => step.status === "queued")) return "queued";
  if (steps.some((step) => step.status === "no_changes")) return "no_changes";
  return "succeeded";
}

function stepRangeDuration(steps: TimelineStep[]) {
  if (steps.length === 0) return 0;
  const starts = steps.map((step) => new Date(step.createdAt).getTime()).filter(Number.isFinite);
  const ends = steps.map((step) => new Date(step.createdAt).getTime() + (step.durationMs ?? 0)).filter(Number.isFinite);
  if (starts.length === 0 || ends.length === 0) return steps.reduce((total, step) => Math.max(total, step.durationMs ?? 0), 0);
  const startedAt = Math.min(...starts);
  const endedAt = Math.max(...ends);
  return endedAt >= startedAt ? endedAt - startedAt : 0;
}

function spanSummary(span: RunSpan) {
  const explicitSummary = typeof span.metadata.summary === "string" ? span.metadata.summary : null;
  if (explicitSummary) return explicitSummary;
  if (span.status === "running") return "Still running.";
  if (span.durationMs != null) return `${titleCase(span.source)} work took ${formatDuration(span.durationMs)}.`;
  return `${titleCase(span.source)} work has no completed duration yet.`;
}

function isEnvelopeSpan(span: RunSpan) {
  return /\b(kubernetes sandbox|sandbox command|run total|task total|sandbox lifetime)\b/i.test(span.name.replace(/[._-]+/g, " "));
}

function isLowSignalTimelineEvent(event: RunEvent) {
  if (event.level === "warn" || event.level === "error") return false;
  const text = `${event.name} ${event.summary ?? ""}`.toLowerCase().replace(/[._-]+/g, " ");
  return /\b(task progress|progress update|heartbeat|stream chunk|log chunk)\b/.test(text);
}

function isDuplicateSpanEvent(event: RunEvent, spans: RunSpan[]) {
  const eventName = normalizedTimelineName(event.name);
  const eventDuration = event.durationMs ?? 0;
  if (!eventName || eventDuration <= 0) return false;
  return spans.some((span) => {
    if (normalizedTimelineName(span.name) !== eventName && !(eventName === "sandbox command" && span.source === "command")) return false;
    const spanDuration = span.durationMs ?? 0;
    if (spanDuration <= 0) return false;
    return Math.abs(spanDuration - eventDuration) < 750;
  });
}

function normalizedTimelineName(value: string) {
  return value.toLowerCase().replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}

function phaseForText(name: string, source: string, summary?: string | null): TimelinePhaseId {
  const text = `${name} ${source} ${summary ?? ""}`.toLowerCase().replace(/[._-]+/g, " ");
  if (/\b(mention received|message received|user prompt|input|request received|task queued|queued)\b/.test(text)) return "initial";
  if (/\b(verify|test|lint|scan|commit|push|pull request|pr|cleanup|persist|save|finaliz|reconcile)\b/.test(text)) return "cleanup";
  if (/\b(sandbox|dependency|dependencies|install|clone|checkout|permission|memory|context|preflight|cache|load channel|resolve discord)\b/.test(text)) return "setup";
  if (/\b(codex|model|openrouter|tool|chat|completion|agent request|search discord|discord history|discord stats|generate image)\b/.test(text)) return "execution";
  if (/\b(reply|respond|response|completed|failed|cancelled|discord mention failed|message sent|message edit|final answer)\b/.test(text)) return "response";
  return "execution";
}

function conversationFlow(snapshot: RunSnapshot): FlowItem[] {
  const eventItems = snapshot.events.filter(isFlowEvent).map((event): FlowItem => {
    const callType = callKind(event);
    return {
      id: `event-${event.id}`,
      kind: event.level === "error" ? "error" : eventKind(event, callType),
      title: humanizeEventName(event.name),
      summary: event.summary ?? "No summary",
      createdAt: event.createdAt,
      durationMs: event.durationMs,
      source: event.source,
      level: event.level,
      metadata: event.metadata
    };
  });
  const artifactItems = snapshot.artifacts.filter(isFlowArtifact).map((artifact): FlowItem => ({
    id: `artifact-${artifact.artifactId}`,
    kind: artifactKind(artifact),
    title: artifact.name,
    summary: artifact.preview || `${artifact.kind} artifact`,
    createdAt: artifact.createdAt,
    durationMs: null,
    source: "artifact",
    level: null,
    metadata: artifact.metadata,
    artifact
  }));
  return [...eventItems, ...artifactItems].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
}

function isFlowEvent(event: RunEvent) {
  if (event.level === "error") return true;
  if (isLowSignalTimelineEvent(event)) return false;
  const kind = callKind(event);
  if (kind === "model" || kind === "tool") return true;
  return /\b(prompt|input|mention|message|reply|respond|response|completed|failed|final answer)\b/i.test(`${event.name} ${event.summary ?? ""}`);
}

function isFlowArtifact(artifact: RunArtifact) {
  return /\b(prompt|response|transcript|conversation|model|tool|message|error|request|reply)\b/i.test(`${artifact.kind} ${artifact.name}`);
}

function eventKind(event: RunEvent, callType: ReturnType<typeof callKind>): FlowItemKind {
  if (callType === "model") return "model";
  if (callType === "tool") return "tool";
  if (/\b(reply|respond|response|completed|final answer)\b/i.test(`${event.name} ${event.summary ?? ""}`)) return "response";
  return "input";
}

function artifactKind(artifact: RunArtifact): FlowItemKind {
  const text = `${artifact.kind} ${artifact.name}`.toLowerCase();
  if (/error|response|reply/.test(text)) return "response";
  if (/model|transcript|conversation/.test(text)) return "model";
  if (/tool/.test(text)) return "tool";
  return "artifact";
}

function timelineStepIcon(kind: TimelineStepKind) {
  if (kind === "span" || kind === "event") return <Activity />;
  if (kind === "model" || kind === "input" || kind === "response") return <MessageSquare />;
  if (kind === "tool") return <Wrench />;
  if (kind === "error") return <XCircle />;
  return <FileText />;
}

function timelineStepLabel(kind: TimelineStepKind) {
  if (kind === "span") return "phase";
  if (kind === "event") return "event";
  return kind;
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

function latencyBreakdown(snapshot: RunSnapshot): LatencyRow[] {
  return snapshot.spans
    .filter((span): span is LatencyRow => typeof span.durationMs === "number" && Number.isFinite(span.durationMs))
    .sort((left, right) => right.durationMs - left.durationMs);
}

function latencyTotal(snapshot: RunSnapshot) {
  if (typeof snapshot.run.durationMs === "number" && Number.isFinite(snapshot.run.durationMs) && snapshot.run.durationMs > 0) {
    return snapshot.run.durationMs;
  }
  return snapshot.spans.reduce((total, span) => total + (span.durationMs ?? 0), 0);
}

function formatDuration(value: number | null | undefined) {
  if (value == null) return "live";
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

function formatRelative(value: string) {
  const ms = Date.now() - new Date(value).getTime();
  if (ms < 60_000) return "now";
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h`;
  return `${Math.floor(ms / (24 * 60 * 60_000))}d`;
}

function eventsWithTiming(events: RunEvent[], startedAt: string) {
  return events.map((event, index) => {
    const previous = index > 0 ? events[index - 1] : null;
    const gapMs = previous ? new Date(event.createdAt).getTime() - new Date(previous.createdAt).getTime() : null;
    return {
      event,
      gapMs: gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null,
      offset: formatOffset(startedAt, event.createdAt)
    };
  });
}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

function formatOffset(startedAt: string, eventAt: string) {
  const offset = new Date(eventAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(offset)) return "unknown";
  if (offset < 0) return "+0.000s";
  return `+${formatDuration(offset)}`;
}

function formatSignedDuration(value: number) {
  return `+${formatDuration(value)} since prior`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
