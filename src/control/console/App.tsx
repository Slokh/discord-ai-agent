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
type TimedRunEvent = { event: RunEvent; gapMs: number | null; offset: string };
type TimelineStepKind = FlowItemKind | "span" | "event" | "run";
export type TimelineStep = {
  id: string;
  kind: TimelineStepKind;
  title: string;
  summary: string;
  createdAt: string;
  durationMs: number | null;
  durationStartedAt: string | null;
  gapMs: number | null;
  offset: string;
  source: string;
  status: RunStatus | null;
  level: EventLevel | null;
  metadata: Record<string, unknown>;
  artifact?: RunArtifact;
};
export type TimelineToolRequest = {
  id?: string | null;
  name: string;
  argumentsText?: string | null;
};
export type TimelineStepGroup = {
  id: string;
  parent: TimelineStep;
  children: TimelineStep[];
};
type TimelineTrace = {
  steps: TimelineStep[];
  groups: TimelineStepGroup[];
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
  const relatedRuns = snapshot.relatedRuns ?? [];
  const activeRelatedRuns = relatedRuns.filter((run) => !isTerminal(run.status));
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
        {relatedRuns.length > 0 && <Metric label="Related" value={relatedRuns.length} tone={activeRelatedRuns.length > 0 ? "info" : "normal"} />}
      </section>
      {relatedRuns.length > 0 && (
        <section className="panel wide">
          <div className="panel-title">
            <Link2 />
            <h3>Related Runs</h3>
          </div>
          <RelatedRunList runs={relatedRuns} generatedAt={snapshot.generatedAt} />
        </section>
      )}
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

function RelatedRunList({ runs, generatedAt }: { runs: RunSummary[]; generatedAt: string }) {
  return (
    <div className="related-run-list">
      {runs.map((run) => {
        const durationMs = relatedRunDurationMs(run, generatedAt);
        return (
          <a className={`related-run-card ${run.status}`} href={runHref(run.runId, "timeline")} key={run.runId}>
            <div className="related-run-card-top">
              <StatusTag status={run.status} />
              <Tag intent="neutral">{run.kind}</Tag>
              <span>{formatDuration(durationMs)}</span>
            </div>
            <strong>{run.title}</strong>
            <p>{relatedRunSummary(run, { includeTitle: false }) || run.runId}</p>
          </a>
        );
      })}
    </div>
  );
}

function Timeline({ snapshot }: { snapshot: RunSnapshot }) {
  const [level, setLevel] = useState<EventLevel | "all">("all");
  const [source, setSource] = useState<string>("all");
  const flowItems = useMemo(() => conversationFlow(snapshot), [snapshot]);
  const relatedRuns = useMemo(() => snapshot.relatedRuns ?? [], [snapshot.relatedRuns]);
  const sources = useMemo(
    () =>
      uniqueStrings([
        ...snapshot.events.map((event) => event.source),
        ...snapshot.spans.map((span) => span.source),
        ...flowItems.map((item) => item.source),
        ...relatedRuns.map(() => "related run")
      ]).sort(),
    [snapshot.events, snapshot.spans, flowItems, relatedRuns]
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
  const visibleRelatedRuns = relatedRuns.filter((run) => {
    if (source !== "all" && source !== "related run") return false;
    if (level === "debug") return false;
    if (level === "error") return run.status === "failed" || run.status === "cancelled";
    if (level === "warn") return run.status === "no_changes";
    return true;
  });
  const timelineStartedAt = timelineStart(snapshot.run.startedAt, events, spans, flows);
  const timedEvents = eventsWithTiming(events, timelineStartedAt);
  const baseTrace = codegenTimelineTrace(snapshot, { events, spans, startedAt: timelineStartedAt }) ?? timelineTrace({ events: timedEvents, spans, flows, startedAt: timelineStartedAt });
  const relatedSteps = relatedRunTimelineSteps(visibleRelatedRuns, {
    startedAt: timelineStartedAt,
    generatedAt: snapshot.generatedAt
  });
  const trace = relatedSteps.length > 0 ? buildTimelineTrace([...baseTrace.steps, ...relatedSteps]) : baseTrace;

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
      {trace.groups.length === 0 ? (
        <Empty label="No timeline items match these filters" />
      ) : (
        <div className="timeline-trace">
          <div className={`timeline-summary-strip ${trace.status}`}>
            <div>
              <strong>{formatDuration(trace.durationMs)}</strong>
              <span>measured duration</span>
            </div>
            <div>
              <strong>{trace.groups.length}</strong>
              <span>top-level steps</span>
            </div>
            {trace.slowest && (
              <div title={trace.slowest.name}>
                <strong>{formatDuration(trace.slowest.durationMs)}</strong>
                <span>slowest step</span>
              </div>
            )}
          </div>
          <ol className="timeline-list flat-timeline">
            {trace.groups.map((group) => (
              <TimelineGroupItem key={group.id} group={group} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function TimelineGroupItem({ group }: { group: TimelineStepGroup }) {
  return (
    <li className={`timeline-step ${group.parent.kind} ${group.parent.level ?? group.parent.status ?? ""}`}>
      <div className="timeline-rail">
        <div className="timeline-dot" />
      </div>
      <article className="timeline-card">
        <TimelineStepHeader step={group.parent} />
        <TimelineStepDetails step={group.parent} />
        <TimelineStepMeta step={group.parent} />
        {group.parent.artifact && <TimelineArtifactInline artifact={group.parent.artifact} />}
        {group.children.length > 0 && (
          <div className="timeline-children">
            {group.children.map((child) => (
              <article key={child.id} className={`timeline-child ${child.kind} ${child.level ?? child.status ?? ""}`}>
                <TimelineStepHeader step={child} child />
                <TimelineStepDetails step={child} />
                <TimelineStepMeta step={child} />
                {child.artifact && <TimelineArtifactInline artifact={child.artifact} />}
                {Object.keys(child.metadata).length > 0 && (
                  <details>
                    <summary>Metadata</summary>
                    <MetadataPreview metadata={child.metadata} />
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
        {Object.keys(group.parent.metadata).length > 0 && (
          <details>
            <summary>Metadata</summary>
            <MetadataPreview metadata={group.parent.metadata} />
          </details>
        )}
      </article>
    </li>
  );
}

function TimelineStepDetails({ step }: { step: TimelineStep }) {
  if (step.artifact) return null;
  if (step.kind === "run") return <RelatedRunInline step={step} />;
  const toolRequests = timelineToolRequests(step);
  if (isModelRoundTimelineStep(step) && toolRequests.length > 0) return <RequestedTools requests={toolRequests} />;
  const summary = timelineStepSummaryText(step);
  return summary ? <p>{summary}</p> : null;
}

function RelatedRunInline({ step }: { step: TimelineStep }) {
  const runId = typeof step.metadata.runId === "string" ? step.metadata.runId : "";
  return (
    <div className="related-run-inline">
      {step.summary && <p>{step.summary}</p>}
      {runId && (
        <a href={runHref(runId, "timeline")}>
          Open {step.metadata.kind === "codegen" ? "codegen" : "related"} timeline
          <Link2 />
        </a>
      )}
    </div>
  );
}

function RequestedTools({ requests }: { requests: TimelineToolRequest[] }) {
  return (
    <div className="requested-tools">
      <div className="requested-tools-heading">
        <Wrench />
        <span>Requested tools</span>
      </div>
      <div className="requested-tool-list">
        {requests.map((request, index) => (
          <div className="requested-tool" key={`${request.id ?? request.name}-${index}`}>
            <div className="requested-tool-name">
              <span>{index + 1}</span>
              <strong>{request.name}</strong>
            </div>
            <ToolArguments argumentsText={request.argumentsText} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolArguments({ argumentsText }: { argumentsText?: string | null }) {
  const parsed = parseToolArgumentsText(argumentsText);
  if (!argumentsText?.trim()) return <span className="tool-args-empty">no args</span>;
  if (parsed && Object.keys(parsed).length > 0) {
    return (
      <div className="tool-args">
        {Object.entries(parsed).map(([key, value]) => (
          <span className="tool-arg" key={key}>
            <b>{key}</b>
            <span>{formatToolArgumentValue(value)}</span>
          </span>
        ))}
      </div>
    );
  }
  return <code className="tool-args-raw">{argumentsText.trim()}</code>;
}

export function timelineStepSummaryText(step: Pick<TimelineStep, "title" | "summary" | "metadata">) {
  const modelSummary = modelRoundSummaryText(step);
  if (modelSummary) return modelSummary;
  return timelineSummaryText(step.summary);
}

export function timelineSummaryText(summary: string) {
  const trimmed = summary.trim();
  if (!trimmed) return "";
  if (/^no summary(?: recorded)?\.?$/i.test(trimmed)) return "";
  if (/^sent thinking reply\.?$/i.test(trimmed)) return "";
  if (/^thinking\.\.\.$/i.test(trimmed)) return "";
  if (/^[\w -]+ work took \d+(?:\.\d+)?s\.?$/i.test(trimmed)) return "";
  if (/^[\w -]+ work took \d+m \d+s\.?$/i.test(trimmed)) return "";
  return trimmed;
}

function modelRoundSummaryText(step: Pick<TimelineStep, "title" | "summary" | "metadata">) {
  if (!isModelRoundTimelineStep(step)) return "";
  const usableTools = timelineToolRequests(step).map((request) => request.name);
  if (usableTools.length > 0) return `Requested tools: ${formatToolCallList(usableTools)}`;
  const outputChars = typeof step.metadata.outputChars === "number" ? step.metadata.outputChars : null;
  if (outputChars != null && outputChars > 0) return `Returned text: ${outputChars} chars`;
  if (outputChars === 0) return "No tool calls or text returned";
  const finishReason = typeof step.metadata.finishReason === "string" ? step.metadata.finishReason : "";
  if (finishReason) return `Finished: ${finishReason}`;
  return timelineSummaryText(step.summary);
}

function stringArrayMetadata(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function timelineToolRequests(step: Pick<TimelineStep, "title" | "metadata">): TimelineToolRequest[] {
  if (!isModelRoundTimelineStep(step)) return [];
  const structuredSelected = toolRequestArrayMetadata(step.metadata.selectedLocalToolRequests);
  if (structuredSelected.length > 0) return structuredSelected;
  const enrichedRequests = toolRequestArrayMetadata(step.metadata.timelineToolRequests);
  if (enrichedRequests.length > 0) return enrichedRequests;
  const structuredRequested = toolRequestArrayMetadata(step.metadata.requestedToolRequests);
  if (structuredRequested.length > 0) return structuredRequested;
  const selectedTools = stringArrayMetadata(step.metadata.selectedLocalTools).map((name) => ({ name }));
  if (selectedTools.length > 0) return selectedTools;
  return stringArrayMetadata(step.metadata.requestedToolCalls).map((name) => ({ name }));
}

function toolRequestArrayMetadata(value: unknown): TimelineToolRequest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TimelineToolRequest[] => {
    if (typeof item === "string" && item.trim()) return [{ name: item.trim() }];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
    return [
      {
        ...(id ? { id } : {}),
        name,
        argumentsText: toolRequestArgumentsText(record)
      }
    ];
  });
}

function toolRequestArgumentsText(record: Record<string, unknown>) {
  for (const key of ["argumentsText", "argumentsPreview", "argumentsSummary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const value = record.arguments;
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatToolCallList(tools: string[]) {
  const counts = new Map<string, number>();
  for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  return [...counts.entries()].map(([tool, count]) => (count > 1 ? `${tool} x${count}` : tool)).join(", ");
}

function parseToolArgumentsText(argumentsText?: string | null): Record<string, unknown> | null {
  if (!argumentsText?.trim()) return null;
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function formatToolArgumentValue(value: unknown) {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isModelRoundTimelineStep(step: Pick<TimelineStep, "title">) {
  return /\bagent model round complete\b/.test(normalizedTimelineName(step.title));
}

export function timelineTitleText(step: Pick<TimelineStep, "title" | "summary" | "kind" | "source">) {
  const title = normalizedTimelineName(step.title);
  const toolName = toolNameFromSummary(step.summary);
  if (/\b(discord mention received|discord user prompt|user prompt)\b/.test(title)) return "User prompt";
  if (/\b(discord thinking sent|thinking reply sent)\b/.test(title)) return "Acknowledgement sent";
  if (/\b(load channel memory|load memory)\b/.test(title)) return "Load conversation memory";
  if (/\b(resolve discord permissions|permissions visibility resolved)\b/.test(title)) return "Check user access";
  if (/\b(discord reply context resolved|reply context resolved)\b/.test(title)) return "Load reply context";
  if (/\bagent model round complete\b/.test(title)) {
    const round = step.summary.match(/^Round\s+(\d+)/i)?.[1];
    return round ? `LLM call ${round}` : "LLM call";
  }
  if (/\bagent tool complete\b/.test(title)) return toolName ? `Tool call: ${toolName}` : "Tool call";
  if (/\bget discord channel topics\b/.test(title)) return "Channel topics query";
  if (/\bcompose channel topics\b/.test(title)) return "Topic summary composed";
  if (/\bget discord stats\b/.test(title)) return "Discord stats query";
  if (/\bmodel tool router\b/.test(title)) return "Tool selection";
  if (/\bagent tool started\b/.test(title)) return toolName ? `Start tool: ${toolName}` : "Start tool";
  if (/\bagent request started\b/.test(title)) return "Start agent run";
  if (/\bagent response ready\b/.test(title)) return "Answer ready";
  if (/\bagent final synthesis started\b/.test(title)) return "Compose final answer";
  if (/\b(discord final response|final response)\b/.test(title)) return "Final answer sent";
  if (/\bchat\b/.test(title) && step.source === "tool") return "LLM response";
  return step.title;
}

function toolNameFromSummary(summary: string) {
  const match = summary.match(/^([A-Za-z][\w.-]*)(?::|\b)/);
  return match?.[1] ?? "";
}

function TimelineStepHeader({ step, child = false }: { step: TimelineStep; child?: boolean }) {
  return (
    <div className={child ? "timeline-child-title" : "timeline-title"}>
      <span className={`timeline-icon ${step.kind}`}>{timelineStepIcon(step.kind)}</span>
      <div className="timeline-step-main">
        <strong>{timelineTitleText(step)}</strong>
        <span>{step.source}</span>
      </div>
      {step.durationMs != null && (
        <div className="time-stack">
          <strong>{formatDuration(step.durationMs)}</strong>
          <small>duration</small>
        </div>
      )}
    </div>
  );
}

function TimelineStepMeta({ step }: { step: TimelineStep }) {
  return (
    <div className="timeline-meta">
      <span className={`timeline-kind ${step.kind}`}>{timelineStepLabel(step.kind)}</span>
      <span>{formatDate(step.createdAt)}</span>
      {step.level && <span className={`level-text ${step.level}`}>{step.level}</span>}
      {step.status && <span className={`level-text ${step.status}`}>{step.status}</span>}
      {step.artifact && <span>{formatBytes(step.artifact.sizeBytes)}</span>}
    </div>
  );
}

function TimelineArtifactInline({ artifact }: { artifact: RunArtifact }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    fetchArtifact(artifact.runId, artifact.artifactId)
      .then((nextContent) => {
        if (!disposed) setContent(nextContent);
      })
      .catch((loadError) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [artifact.artifactId, artifact.runId]);

  const visibleContent = content || artifact.preview;
  return (
    <>
      {loading && <span className="timeline-artifact-loading">Loading full artifact...</span>}
      {error && (
        <div className="jump-error">
          <AlertCircle />
          <span>{error}</span>
        </div>
      )}
      {isCodexTranscriptArtifact(artifact) ? <CodexTranscript artifact={artifact} content={visibleContent} /> : <pre className="timeline-artifact-code">{visibleContent}</pre>}
    </>
  );
}

function CodexTranscript({ artifact, content }: { artifact: RunArtifact; content: string }) {
  const transcript = useMemo(() => parseCodexTranscript(content), [content]);
  if (!transcript.isTranscript) return <pre className="timeline-artifact-code">{content}</pre>;
  const watchdog = objectValue(artifact.metadata.watchdog);
  const watchdogKilled = watchdog?.killed === true;
  const watchdogReason = stringValue(watchdog?.reason);
  const watchdogDurationMs = numericMetadata(watchdog?.durationMs);
  const lastOutputAtMs = numericMetadata(watchdog?.lastOutputAtMs);
  return (
    <div className="codex-transcript">
      {watchdogKilled && (
        <div className="codex-transcript-stop">
          <strong>Stopped by watchdog{watchdogReason ? `: ${watchdogReason}` : ""}</strong>
          <span>
            {[
              watchdogDurationMs != null ? `Stopped after ${formatDuration(watchdogDurationMs)}` : "",
              lastOutputAtMs != null ? `last output at ${formatDuration(lastOutputAtMs)}` : ""
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      )}
      <div className="codex-transcript-summary">
        <Metric label="Messages" value={transcript.agentMessages} />
        <Metric label="Commands" value={transcript.commands} />
        <Metric label="Reasoning" value={`${transcript.reasoningDeltaCount} chunks`} />
        <Metric label="Tokens" value={transcript.tokenTotal == null ? "unknown" : transcript.tokenTotal.toLocaleString()} />
      </div>
      <div className="codex-transcript-list">
        {transcript.items.map((item) => (
          <article key={item.id} className={`codex-transcript-item ${item.kind}`}>
            <div className="codex-transcript-item-head">
              <strong>{item.title}</strong>
              <span>{formatDate(item.timestamp)}</span>
            </div>
            {item.body && <p>{item.body}</p>}
            {item.command && <code>{item.command}</code>}
            {item.output && <pre>{item.output}</pre>}
          </article>
        ))}
      </div>
    </div>
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

function runHref(runId: string, tab: DetailTab = "overview") {
  const params = new URLSearchParams(window.location.search);
  for (const key of managedSearchParams) params.delete(key);
  if (tab !== "overview") params.set("tab", tab);
  return `${runsRoutePrefix()}/${encodeURIComponent(runId)}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
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

function timelineTrace({ events, spans, flows, startedAt }: { events: TimedRunEvent[]; spans: RunSpan[]; flows: FlowItem[]; startedAt: string }): TimelineTrace {
  const steps: TimelineStep[] = [];
  const flowEventIds = new Set(flows.map((flow) => flow.id.match(/^event-(.+)$/)?.[1]).filter(Boolean));
  for (const span of spans) {
    if (isEnvelopeSpan(span)) continue;
    steps.push(timelineStepFromSpan(span, startedAt));
  }
  for (const flow of flows) {
    steps.push(timelineStepFromFlow(flow, startedAt));
  }
  for (const event of events) {
    if (flowEventIds.has(event.event.id)) continue;
    if (isLowSignalTimelineEvent(event.event)) continue;
    if (isDuplicateSpanEvent(event.event, spans)) continue;
    steps.push(timelineStepFromEvent(event));
  }
  return buildTimelineTrace(steps);
}

export function relatedRunTimelineSteps(runs: RunSummary[], input: { startedAt: string; generatedAt: string }): TimelineStep[] {
  return runs.map((run) => {
    const durationMs = relatedRunDurationMs(run, input.generatedAt);
    return {
      id: `related-run-${run.runId}`,
      kind: "run",
      title: relatedRunTitle(run),
      summary: relatedRunSummary(run),
      createdAt: run.startedAt,
      durationMs,
      durationStartedAt: run.startedAt,
      gapMs: null,
      offset: formatOffset(input.startedAt, run.startedAt),
      source: "related run",
      status: run.status,
      level: run.status === "failed" || run.status === "cancelled" ? "error" : null,
      metadata: {
        runId: run.runId,
        traceId: run.traceId,
        kind: run.kind,
        currentStep: run.currentStep,
        links: run.links
      }
    };
  });
}

function relatedRunTitle(run: RunSummary) {
  const kind = run.kind === "codegen" ? "Codegen task" : `${titleCase(run.kind)} run`;
  if (run.status === "running") return `${kind} running`;
  if (run.status === "queued") return `${kind} queued`;
  if (run.status === "succeeded") return `${kind} completed`;
  if (run.status === "no_changes") return `${kind} finished with no changes`;
  if (run.status === "cancelled") return `${kind} cancelled`;
  return `${kind} failed`;
}

function relatedRunSummary(run: RunSummary, options: { includeTitle?: boolean } = {}) {
  const includeTitle = options.includeTitle ?? true;
  return [includeTitle ? run.title : null, run.currentStep ? `Current step: ${run.currentStep}.` : null, run.summary, typeof run.links.pullRequest === "string" ? `PR: ${run.links.pullRequest}` : null]
    .filter((item): item is string => Boolean(item))
    .join(" ");
}

function relatedRunDurationMs(run: RunSummary, generatedAt: string) {
  if (typeof run.durationMs === "number" && Number.isFinite(run.durationMs)) return run.durationMs;
  if (isTerminal(run.status)) return null;
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = new Date(generatedAt).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
  return endedAt - startedAt;
}

export function codegenTimelineTrace(
  snapshot: RunSnapshot,
  { events, spans, startedAt }: { events: RunEvent[]; spans: RunSpan[]; startedAt: string }
): TimelineTrace | null {
  if (snapshot.run.kind !== "codegen") return null;
  const groups: TimelineStepGroup[] = [];
  const addGroup = (parent: TimelineStep, children: TimelineStep[] = []) => {
    groups.push({ id: parent.id, parent, children: sortTimelineSteps(children) });
  };
  const event = (predicate: (event: RunEvent) => boolean) => preferredTimelineEvent(events.filter(predicate));
  const progress = (step: string) => event((candidate) => candidate.name === "task.progress" && candidate.metadata.step === step);
  const span = (name: string) => preferredTimelineSpan(spans.filter((candidate) => normalizedTimelineName(candidate.name) === normalizedTimelineName(name)));
  const artifacts = (predicate: (artifact: RunArtifact) => boolean) =>
    snapshot.artifacts.filter(predicate).map((artifact) => timelineStepFromCodegenArtifact(artifact, startedAt));

  const mention = event((candidate) => candidate.name === "discord.mention.received");
  if (mention) {
    addGroup(timelineStepFromCodegenEvent(mention, startedAt, { title: "User prompt received", kind: "input" }));
  }

  const modelSelection = event((candidate) => candidate.name === "agent.model.round.complete" && stringArrayMetadata(candidate.metadata.selectedLocalTools).includes("openGithubPullRequest"));
  if (modelSelection) {
    addGroup(timelineStepFromCodegenEvent(modelSelection, startedAt, { title: "Model chose code update", kind: "model" }));
  }

  const codegenTool = event((candidate) => candidate.name === "agent.tool.complete" && candidate.metadata.toolName === "openGithubPullRequest");
  if (codegenTool) {
    addGroup(
      timelineStepFromCodegenEvent(codegenTool, startedAt, {
        title: "Codegen task queued",
        kind: "tool",
        summary: codegenQueuedSummary(events)
      })
    );
  }

  const sandboxStarted = progress("sandbox_acquired");
  if (sandboxStarted) {
    addGroup(timelineStepFromCodegenEvent(sandboxStarted, startedAt, { title: "Sandbox process started", durationMs: sandboxStarted.durationMs }));
  }

  const phaseRows = [
    { name: "repo", title: "Repository prepared", artifacts: artifacts(isRepositorySetupArtifact) },
    { name: "dependencies", title: "Dependencies installed", artifacts: artifacts((artifact) => artifact.metadata.step === "dependencies") },
    { name: "toolShims", title: "Helper tools installed", artifacts: [] },
    { name: "context", title: "Codegen context built", artifacts: artifacts((artifact) => artifact.kind === "diagnostic" && /codegen request context/i.test(artifact.name)) }
  ];
  for (const phase of phaseRows) {
    const phaseSpan = span(phase.name);
    if (phaseSpan) addGroup(timelineStepFromCodegenSpan(phaseSpan, startedAt, { title: phase.title }), phase.artifacts);
  }

  for (const attempt of codegenAttemptSpans(spans)) {
    const attemptNumber = codegenAttemptNumber(attempt.name);
    if (attemptNumber == null) continue;
    const harnessName = codegenAttemptHarnessName(attempt.name);
    const deadline = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        Boolean(stringMetadata(candidate.metadata.step)?.endsWith("first_diff_deadline")) &&
        candidate.metadata.attempt === attemptNumber
    );
    const reasoningStarted = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        candidate.metadata.step === "codex_app_server_item_started" &&
        candidate.metadata.attempt === attemptNumber &&
        /\breasoning\b/i.test(candidate.summary ?? "")
    );
    const firstDiff = event(
      (candidate) => {
        const step = String(candidate.metadata.step ?? "");
        return candidate.name === "task.progress" && (step === "codex_first_diff" || step === "codex_app_server_first_diff" || step === "opencode_first_diff") && candidate.metadata.attempt === attemptNumber;
      }
    );
    const watchdog = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        String(candidate.metadata.step ?? "").includes("watchdog_no_first_diff") &&
        candidate.metadata.attempt === attemptNumber
    );
    const noDiff = event(
      (candidate) =>
        candidate.name === "task.progress" &&
        (String(candidate.metadata.step ?? "") === `codex_app_server_attempt_${attemptNumber}_no_diff` ||
          String(candidate.metadata.step ?? "") === `opencode_attempt_${attemptNumber}_no_diff`) &&
        candidate.metadata.attempt === attemptNumber
    );
    const children = [
      ...artifacts((artifact) => isCodegenAttemptArtifact(artifact, attemptNumber)),
      deadline
        ? timelineStepFromCodegenEvent(deadline, startedAt, {
            title: "First-diff deadline set",
            kind: "event",
            durationMs: null
          })
        : null,
      reasoningStarted
        ? timelineStepFromCodegenEvent(reasoningStarted, startedAt, {
            title: "Model started reasoning",
            kind: "model",
            durationMs: null
          })
        : null,
      firstDiff
        ? timelineStepFromCodegenEvent(firstDiff, startedAt, {
            title: "First code diff produced",
            kind: "event",
            durationMs: null
          })
        : null,
      watchdog
        ? timelineStepFromCodegenEvent(watchdog, startedAt, {
            title: "No-diff watchdog fired",
            kind: "error",
            durationMs: null
          })
        : null,
      noDiff
        ? timelineStepFromCodegenEvent(noDiff, startedAt, {
            title: "Attempt ended with no diff",
            kind: "error",
            durationMs: null,
            summary: codegenAttemptNoDiffSummary(noDiff)
          })
        : null
    ].filter((step): step is TimelineStep => step != null);

    addGroup(
      timelineStepFromCodegenSpan(attempt, startedAt, {
        title: `${harnessName} attempt ${attemptNumber}`,
        kind: attempt.status === "failed" ? "error" : "model",
        summary: codegenAttemptSummary(attempt, noDiff ?? watchdog)
      }),
      children
    );
  }

  const cleanup = progress("cleanup");
  if (cleanup) addGroup(timelineStepFromCodegenEvent(cleanup, startedAt, { title: "Cleanup started" }));

  const completed = event((candidate) => candidate.name === "task.completed");
  if (completed) {
    addGroup(
      timelineStepFromCodegenEvent(completed, startedAt, {
        title: snapshot.run.status === "no_changes" ? "No PR opened" : "Run completed",
        kind: completed.level === "error" ? "error" : "response",
        summary: completed.summary ?? snapshot.run.summary ?? ""
      })
    );
  }

  if (groups.length === 0) return null;
  const sortedGroups = groups.sort((left, right) => timelineStepStartMs(left.parent) - timelineStepStartMs(right.parent));
  const steps = sortTimelineSteps(sortedGroups.flatMap((group) => [group.parent, ...group.children]));
  const durations = sortedGroups
    .map((group) => ({ name: timelineTitleText(group.parent), durationMs: group.parent.durationMs ?? 0 }))
    .filter((item) => item.durationMs > 0);
  return {
    steps,
    groups: sortedGroups,
    durationMs: summedStepDuration(sortedGroups.map((group) => group.parent)),
    status: snapshot.run.status,
    slowest: durations.length > 0 ? durations.reduce((current, item) => (item.durationMs > current.durationMs ? item : current), durations[0]!) : null
  };
}

function timelineStepFromCodegenSpan(
  span: RunSpan,
  startedAt: string,
  overrides: Partial<Pick<TimelineStep, "title" | "summary" | "kind" | "durationMs">> = {}
): TimelineStep {
  return {
    ...timelineStepFromSpan(span, startedAt),
    ...overrides,
    id: `codegen-${span.id}`
  };
}

function preferredTimelineEvent(events: RunEvent[]) {
  const preference = ["task", "trace", "process", "command", "tool"];
  return [...events].sort((left, right) => preference.indexOf(left.source) - preference.indexOf(right.source))[0] ?? null;
}

function preferredTimelineSpan(spans: RunSpan[]) {
  const preference = ["task", "command", "process", "sandbox"];
  return [...spans].sort((left, right) => preference.indexOf(left.source) - preference.indexOf(right.source))[0] ?? null;
}

function codegenAttemptSpans(spans: RunSpan[]) {
  return spans
    .filter((span) => codegenAttemptNumber(span.name) != null)
    .sort((left, right) => {
      const leftAttempt = codegenAttemptNumber(left.name) ?? 0;
      const rightAttempt = codegenAttemptNumber(right.name) ?? 0;
      return leftAttempt - rightAttempt;
    });
}

function codegenAttemptNumber(value: string) {
  const match = value.match(/(?:codex_(?:app_server_)?|opencode_)attempt_(\d+)/);
  if (!match?.[1]) return null;
  const attempt = Number(match[1]);
  return Number.isFinite(attempt) ? attempt : null;
}

function codegenAttemptHarnessName(value: string) {
  return value.includes("opencode") ? "OpenCode" : "Codex";
}

function codegenQueuedSummary(events: RunEvent[]) {
  const queued = preferredTimelineEvent(events.filter((event) => event.name === "openGithubPullRequest" || event.metadata.toolName === "openGithubPullRequest"));
  if (!queued?.summary) return "The model handed this request to the codegen worker.";
  try {
    const parsed = JSON.parse(queued.summary);
    if (parsed && typeof parsed === "object") {
      const taskId = typeof (parsed as Record<string, unknown>).taskId === "string" ? (parsed as Record<string, unknown>).taskId : null;
      if (taskId) return `Queued codegen task ${taskId}.`;
    }
  } catch {
    // Fall through to the plain summary.
  }
  return queued.summary;
}

function codegenAttemptSummary(attempt: RunSpan, outcome: RunEvent | null) {
  const parts = [`Ran ${String(attempt.metadata.command ?? attempt.name)}.`];
  const exitCode = numericMetadata(attempt.metadata.exitCode ?? outcome?.metadata.exitCode);
  const watchdogReason = stringMetadata(outcome?.metadata.watchdogReason) ?? stringMetadata((attempt.metadata.watchdog as Record<string, unknown> | undefined)?.reason);
  const gitStatus = stringMetadata(outcome?.metadata.gitStatus);
  if (exitCode != null) parts.push(`Exit ${exitCode}.`);
  if (watchdogReason) parts.push(`Watchdog: ${watchdogReason}.`);
  if (gitStatus === "") parts.push("Git status was clean.");
  return parts.join(" ");
}

function codegenAttemptNoDiffSummary(event: RunEvent) {
  const pieces = ["No code diff was produced."];
  const exitCode = numericMetadata(event.metadata.exitCode);
  const watchdogReason = stringMetadata(event.metadata.watchdogReason);
  const notificationCount = numericMetadata(event.metadata.notificationCount);
  if (exitCode != null) pieces.push(`Exit ${exitCode}.`);
  if (watchdogReason) pieces.push(`Watchdog: ${watchdogReason}.`);
  if (notificationCount != null) pieces.push(`${notificationCount} ${stringMetadata(event.metadata.harness)?.includes("opencode") ? "OpenCode" : "Codex"} notifications.`);
  return pieces.join(" ");
}

function numericMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringMetadata(value: unknown) {
  return typeof value === "string" ? value : null;
}

function isRepositorySetupArtifact(artifact: RunArtifact) {
  if (artifact.kind !== "command_log") return false;
  const step = stringMetadata(artifact.metadata.step);
  return step === "repo_seed" || step === "repo_checkout" || step === "branch";
}

function isCodegenAttemptArtifact(artifact: RunArtifact, attempt: number) {
  const metadataAttempt = numericMetadata(artifact.metadata.attempt);
  if (metadataAttempt === attempt) return true;
  const name = normalizedTimelineName(artifact.name);
  return name.includes(`attempt ${attempt} transcript`);
}

function timelineStepFromCodegenEvent(
  event: RunEvent,
  startedAt: string,
  overrides: Partial<Pick<TimelineStep, "title" | "summary" | "kind" | "durationMs">> = {}
): TimelineStep {
  return {
    id: `codegen-event-${event.id}`,
    kind: event.level === "error" ? "error" : "event",
    title: timelineEventTitle(event.name),
    summary: event.summary ?? "",
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    durationStartedAt: durationStartedAtForCompletedStep(event.createdAt, event.durationMs),
    gapMs: null,
    offset: formatOffset(startedAt, event.createdAt),
    source: event.source,
    status: null,
    level: event.level,
    metadata: event.metadata,
    ...overrides
  };
}

function timelineStepFromCodegenArtifact(artifact: RunArtifact, startedAt: string): TimelineStep {
  return {
    id: `codegen-artifact-${artifact.artifactId}`,
    kind: "artifact",
    title: timelineArtifactTitle(artifact),
    summary: artifact.preview,
    createdAt: artifact.createdAt,
    durationMs: null,
    durationStartedAt: null,
    gapMs: null,
    offset: formatOffset(startedAt, artifact.createdAt),
    source: "artifact",
    status: null,
    level: null,
    metadata: artifact.metadata,
    artifact
  };
}

function timelineArtifactTitle(artifact: RunArtifact) {
  if (artifact.kind === "command_log") {
    const match = artifact.name.match(/^(.+?) command log$/i);
    if (match?.[1]) return `Command: ${match[1]}`;
  }
  return artifact.name;
}

function isCodexTranscriptArtifact(artifact: RunArtifact) {
  return artifact.kind === "command_log" && /\bcodex\b.+\btranscript\b/i.test(artifact.name);
}

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
      tokenTotal = numericMetadata(total?.totalTokens) ?? tokenTotal;
      tokenCached = numericMetadata(total?.cachedInputTokens) ?? tokenCached;
      tokenOutput = numericMetadata(total?.outputTokens) ?? tokenOutput;
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
      const durationMs = numericMetadata(item?.durationMs) ?? paramsPreviewNumberField(record.metadata.paramsPreview, "durationMs") ?? commandDurationFromTimestamps(commandStart?.timestamp, record.timestamp);
      const exitCode = numericMetadata(item?.exitCode) ?? paramsPreviewNumberField(record.metadata.paramsPreview, "exitCode");
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

function sortTimelineSteps(steps: TimelineStep[]) {
  return [...steps]
    .sort((left, right) => {
      const timeDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return timelineStepOrder(left.kind) - timelineStepOrder(right.kind);
    })
    .map((step, index, sortedSteps) => {
      const previous = index > 0 ? sortedSteps[index - 1] : null;
      const gapMs = previous ? new Date(step.createdAt).getTime() - new Date(previous.createdAt).getTime() : null;
      return {
        ...step,
        gapMs: gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null
      };
    });
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

function buildTimelineTrace(steps: TimelineStep[]): TimelineTrace {
  const sortedSteps = withStepGaps(steps);
  const groups = groupTimelineSteps(sortedSteps);
  const countedSteps = groups.map((group) => group.parent);
  const durations = countedSteps.map((step) => ({ name: timelineTitleText(step), durationMs: step.durationMs ?? 0 })).filter((item) => item.durationMs > 0);
  const durationMs = summedStepDuration(countedSteps);
  const slowest = durations.length > 0 ? durations.reduce((current, item) => (item.durationMs > current.durationMs ? item : current), durations[0]!) : null;
  return {
    steps: sortedSteps,
    groups,
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
    durationStartedAt: span.startedAt,
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
    durationStartedAt: durationStartedAtForCompletedStep(flow.createdAt, flow.durationMs),
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
    title: timelineEventTitle(event.name),
    summary: event.summary ?? "No summary recorded.",
    createdAt: event.createdAt,
    durationMs: event.durationMs,
    durationStartedAt: durationStartedAtForCompletedStep(event.createdAt, event.durationMs),
    gapMs: null,
    offset,
    source: event.source,
    status: null,
    level: event.level,
    metadata: event.metadata
  };
}

function timelineEventTitle(name: string) {
  const text = normalizedTimelineName(name);
  if (/\bdiscord mention received\b/.test(text)) return "User prompt";
  if (/\bdiscord thinking sent\b/.test(text)) return "Thinking reply sent";
  return humanizeEventName(name);
}

function withStepGaps(steps: TimelineStep[]) {
  const sortedSteps = [...steps].sort((left, right) => {
      const timeDelta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      if (Number.isFinite(timeDelta) && timeDelta !== 0) return timeDelta;
      return timelineStepOrder(left.kind) - timelineStepOrder(right.kind);
    });
  const enrichedSteps = enrichModelRoundToolRequests(sortedSteps);
  return compactTimelineSteps(enrichedSteps)
    .map((step, index, sortedSteps) => {
      const previous = index > 0 ? sortedSteps[index - 1] : null;
      const gapMs = previous ? new Date(step.createdAt).getTime() - new Date(previous.createdAt).getTime() : null;
      return {
        ...step,
        gapMs: gapMs != null && Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null
      };
    });
}

export function enrichModelRoundToolRequests(steps: TimelineStep[]) {
  const modelSteps = steps.filter(isModelRoundTimelineStep);
  if (modelSteps.length === 0) return steps;
  return steps.map((step) => {
    if (!isModelRoundTimelineStep(step) || timelineToolRequests(step).some((request) => request.argumentsText?.trim())) return step;
    const toolRequests = toolStartRequestsForModelRound(step, steps, modelSteps);
    if (toolRequests.length === 0) return step;
    return {
      ...step,
      metadata: {
        ...step.metadata,
        timelineToolRequests: toolRequests
      }
    };
  });
}

function toolStartRequestsForModelRound(modelStep: TimelineStep, steps: TimelineStep[], modelSteps: TimelineStep[]) {
  const modelCompletedAt = new Date(modelStep.createdAt).getTime();
  if (!Number.isFinite(modelCompletedAt)) return [];
  const nextModel = modelSteps.find((candidate) => {
    if (candidate.id === modelStep.id) return false;
    return timelineStepStartMs(candidate) > modelCompletedAt;
  });
  const nextModelStartedAt = nextModel ? timelineStepStartMs(nextModel) : Number.POSITIVE_INFINITY;
  return steps
    .filter((step) => {
      if (!isToolStartedTimelineStep(step)) return false;
      const startedAt = new Date(step.createdAt).getTime();
      return Number.isFinite(startedAt) && startedAt >= modelCompletedAt && startedAt < nextModelStartedAt;
    })
    .map(toolRequestFromStartedStep)
    .filter((request): request is TimelineToolRequest => request != null);
}

function isToolStartedTimelineStep(step: TimelineStep) {
  return /\bagent tool started\b/.test(normalizedTimelineName(step.title));
}

function toolRequestFromStartedStep(step: TimelineStep): TimelineToolRequest | null {
  const metadataName = typeof step.metadata.toolName === "string" ? step.metadata.toolName.trim() : "";
  const name = metadataName || step.summary.trim();
  if (!name) return null;
  const argumentsText = typeof step.metadata.argumentsPreview === "string" ? step.metadata.argumentsPreview : toolRequestArgumentsText(step.metadata);
  return {
    name,
    argumentsText
  };
}

export function compactTimelineSteps(steps: TimelineStep[]) {
  return steps.filter((step) => {
    if (isEnvelopeTimelineStep(step)) return false;
    if (isRedundantTimelineStep(step, steps)) return false;
    if (isDuplicateTimedStep(step, steps)) return false;
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

function isRedundantTimelineStep(step: TimelineStep, steps: TimelineStep[]) {
  if (step.level === "error") return false;
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (isPromptArtifactDuplicate(step, steps)) return true;
  if (isFinalResponseDuplicate(step, steps)) return true;
  if (/\bagent request started\b/.test(text) && hasModelRoundStep(steps)) return true;
  if (/\bagent response ready\b/.test(text) && hasFinalResponseStep(steps)) return true;
  if (/\bagent final synthesis started\b/.test(text) && hasFinalResponseStep(steps)) return true;
  if (/\bmodel tool router\b/.test(text) && hasModelRoundStep(steps)) return true;
  if (/\bagent tool started\b/.test(text) && hasCompletedToolStep(step, steps)) return true;
  return false;
}

function isPromptArtifactDuplicate(step: TimelineStep, steps: TimelineStep[]) {
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (step.kind !== "artifact" || !/\b(discord user prompt|user prompt)\b/.test(text)) return false;
  const summary = normalizedTimelineName(step.summary);
  return steps.some((candidate) => {
    if (candidate.id === step.id) return false;
    const candidateText = normalizedTimelineName(candidate.title);
    if (!/\b(discord mention received|user prompt|message received)\b/.test(candidateText)) return false;
    return summariesMatch(summary, normalizedTimelineName(candidate.summary));
  });
}

function isFinalResponseDuplicate(step: TimelineStep, steps: TimelineStep[]) {
  const text = normalizedTimelineName(`${step.title} ${step.source}`);
  if (!/\bchat\b/.test(text)) return false;
  const summary = normalizedTimelineName(step.summary);
  return steps.some((candidate) => {
    if (candidate.id === step.id) return false;
    const candidateText = normalizedTimelineName(candidate.title);
    if (!/\b(discord final response|final response)\b/.test(candidateText)) return false;
    return summariesMatch(summary, normalizedTimelineName(candidate.summary));
  });
}

function hasFinalResponseStep(steps: TimelineStep[]) {
  return steps.some((step) => /\b(discord final response|final response)\b/.test(normalizedTimelineName(step.title)));
}

function hasModelRoundStep(steps: TimelineStep[]) {
  return steps.some((step) => /\bagent model round complete\b/.test(normalizedTimelineName(step.title)) && (step.durationMs ?? 0) > 0);
}

function hasCompletedToolStep(step: TimelineStep, steps: TimelineStep[]) {
  const toolName = normalizedTimelineName(step.summary);
  return steps.some((candidate) => {
    if (candidate.id === step.id || (candidate.durationMs ?? 0) <= 0) return false;
    const candidateText = normalizedTimelineName(candidate.title);
    if (!/\bagent tool complete\b/.test(candidateText)) return false;
    if (!toolName) return true;
    return normalizedTimelineName(candidate.summary).includes(toolName);
  });
}

function summariesMatch(left: string, right: string) {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

export function groupTimelineSteps(steps: TimelineStep[]): TimelineStepGroup[] {
  const parentSteps = steps.filter(isTimelineParentStep);
  const childrenByParent = new Map<string, TimelineStep[]>();
  const assignedChildren = new Set<string>();

  for (const child of steps) {
    if (isTimelineParentStep(child)) continue;
    const parent = bestTimelineParent(child, parentSteps);
    if (!parent) continue;
    assignedChildren.add(child.id);
    const children = childrenByParent.get(parent.id) ?? [];
    children.push(child);
    childrenByParent.set(parent.id, children);
  }

  const groups: TimelineStepGroup[] = parentSteps.map((parent) => ({
    id: parent.id,
    parent,
    children: childrenByParent.get(parent.id) ?? []
  }));

  for (const step of steps) {
    if (assignedChildren.has(step.id) || parentSteps.some((parent) => parent.id === step.id)) continue;
    groups.push({ id: step.id, parent: step, children: [] });
  }

  return groups.sort((left, right) => timelineStepStartMs(left.parent) - timelineStepStartMs(right.parent));
}

function isTimelineParentStep(step: TimelineStep) {
  return (step.durationMs ?? 0) > 0;
}

function bestTimelineParent(child: TimelineStep, parents: TimelineStep[]) {
  const childAt = new Date(child.createdAt).getTime();
  if (!Number.isFinite(childAt)) return null;
  const toleranceMs = 1_000;
  const candidates = parents
    .map((parent) => {
      if (!shouldNestTimelineChild(child, parent)) return null;
      const interval = stepTimingInterval(parent);
      if (!interval) return null;
      const exact = childAt >= interval.startedAt && childAt <= interval.endedAt;
      const nearby = childAt >= interval.startedAt - toleranceMs && childAt <= interval.endedAt + toleranceMs;
      if (!exact && !nearby) return null;
      return {
        parent,
        exact,
        durationMs: interval.endedAt - interval.startedAt,
        distanceMs: exact ? 0 : Math.min(Math.abs(childAt - interval.startedAt), Math.abs(childAt - interval.endedAt))
      };
    })
    .filter((candidate): candidate is { parent: TimelineStep; exact: boolean; durationMs: number; distanceMs: number } => candidate != null)
    .sort((left, right) => {
      if (left.exact !== right.exact) return left.exact ? -1 : 1;
      if (left.durationMs !== right.durationMs) return left.durationMs - right.durationMs;
      return left.distanceMs - right.distanceMs;
    });
  return candidates[0]?.parent ?? null;
}

function shouldNestTimelineChild(child: TimelineStep, parent: TimelineStep) {
  if (isTopLevelTimelineMarker(child)) return false;
  if (child.kind === "input" || child.kind === "response" || child.kind === "artifact" || child.kind === "run") return false;
  const childText = normalizedTimelineName(`${child.title} ${child.source}`);
  const parentText = normalizedTimelineName(`${parent.title} ${parent.source}`);
  const parentIsTool = /\btool\b/.test(parentText);
  const parentIsModel = /\b(model|chat|completion|synthesis)\b/.test(parentText);
  if (child.kind === "tool") return parentIsTool;
  if (child.kind === "model") return parentIsModel;
  if (/\b(model|chat|completion|synthesis)\b/.test(childText)) return parentIsModel;
  if (/\btool\b/.test(childText)) return parentIsTool;
  if (child.source === parent.source) return true;
  return /\b(context|permission|resolve|reply)\b/.test(childText) && /\b(context|permission|resolve|reply)\b/.test(parentText);
}

function isTopLevelTimelineMarker(step: TimelineStep) {
  const text = normalizedTimelineName(step.title);
  return /\b(discord mention received|discord user prompt|discord thinking sent|agent request started|agent response ready|discord final response|final response|response ready)\b/.test(text);
}

function timelineStepStartMs(step: TimelineStep) {
  const interval = stepTimingInterval(step);
  if (interval) return interval.startedAt;
  const createdAt = new Date(step.createdAt).getTime();
  return Number.isFinite(createdAt) ? createdAt : Number.MAX_SAFE_INTEGER;
}

function isEnvelopeTimelineStep(step: TimelineStep) {
  if (step.level === "error") return false;
  const text = normalizedTimelineName(`${step.title} ${step.source} ${metadataValue(step.metadata.spanId)}`);
  if (step.kind === "span" && /\b(run model led agent|agent request|sandbox command|run total|task total|sandbox lifetime)\b/.test(text)) return true;
  return (step.durationMs ?? 0) > 0 && /\b(agent request complete|discord mention handled)\b/.test(text);
}

function isDuplicateTimedStep(step: TimelineStep, steps: TimelineStep[]) {
  if (step.kind === "span" || step.level === "error" || (step.durationMs ?? 0) <= 0) return false;
  const stepInterval = stepTimingInterval(step);
  if (!stepInterval) return false;
  return steps.some((candidate) => {
    if (candidate.id === step.id || candidate.kind !== "span" || candidate.source !== "process" || (candidate.durationMs ?? 0) <= 0) return false;
    const candidateInterval = stepTimingInterval(candidate);
    if (!candidateInterval) return false;
    const overlap = Math.max(0, Math.min(stepInterval.endedAt, candidateInterval.endedAt) - Math.max(stepInterval.startedAt, candidateInterval.startedAt));
    const shorterDuration = Math.min(stepInterval.endedAt - stepInterval.startedAt, candidateInterval.endedAt - candidateInterval.startedAt);
    if (shorterDuration <= 0 || overlap / shorterDuration < 0.8) return false;
    return Math.abs((step.durationMs ?? 0) - (candidate.durationMs ?? 0)) < 1_000;
  });
}

function timelineStepOrder(kind: TimelineStepKind) {
  const order: Record<TimelineStepKind, number> = {
    input: 0,
    event: 1,
    model: 2,
    tool: 3,
    span: 4,
    run: 5,
    artifact: 6,
    response: 7,
    error: 8
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

export function summedStepDuration(steps: Array<{ durationMs: number | null | undefined }>) {
  return steps.reduce((total, step) => total + Math.max(0, step.durationMs ?? 0), 0);
}

function durationStartedAtForCompletedStep(createdAt: string, durationMs: number | null | undefined) {
  const completedAt = new Date(createdAt).getTime();
  if (!Number.isFinite(completedAt) || durationMs == null || durationMs <= 0) return null;
  return new Date(completedAt - durationMs).toISOString();
}

function stepTimingInterval(step: { createdAt: string; durationMs: number | null | undefined; durationStartedAt?: string | null }) {
  const startedAt = new Date(step.durationStartedAt ?? step.createdAt).getTime();
  const durationMs = step.durationMs ?? 0;
  if (!Number.isFinite(startedAt) || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return { startedAt, endedAt: startedAt + durationMs };
}

function spanSummary(span: RunSpan) {
  const explicitSummary = typeof span.metadata.summary === "string" ? span.metadata.summary : null;
  if (explicitSummary) return explicitSummary;
  if (span.status === "running") return "Still running.";
  return "";
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

function conversationFlow(snapshot: RunSnapshot): FlowItem[] {
  const eventItems = snapshot.events.filter(isFlowEvent).map((event): FlowItem => {
    const callType = callKind(event);
    return {
      id: `event-${event.id}`,
      kind: event.level === "error" ? "error" : eventKind(event, callType),
      title: timelineEventTitle(event.name),
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
  if (kind === "run") return <Bot />;
  if (kind === "span" || kind === "event") return <Activity />;
  if (kind === "model" || kind === "input" || kind === "response") return <MessageSquare />;
  if (kind === "tool") return <Wrench />;
  if (kind === "error") return <XCircle />;
  return <FileText />;
}

function timelineStepLabel(kind: TimelineStepKind) {
  if (kind === "span") return "span";
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

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
