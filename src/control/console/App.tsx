import {
  Activity,
  AlertCircle,
  Bot,
  Clock3,
  FileText,
  Filter,
  Link2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TerminalSquare,
} from "lucide-react";
import type { ClipboardEvent } from "react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Status, Tabs, Tag } from "regen-ui";
import {
  fetchRunList,
  fetchRunSnapshot,
  resolveRunReference,
  subscribeToRun,
} from "./api.js";
import { Empty, Loading, MetaPill, Metric } from "./consolePrimitives.js";
import {
  normalizeConsoleUrlState,
  readConsoleUrlState,
  runKinds,
  statusFilters,
  writeConsoleUrlState,
  type ConsoleUrlState,
  type DetailTab,
  type HistoryMode,
} from "./consoleRouting.js";
import { ArtifactsView, RawView, TerminalView } from "./detailViews.js";
import { Overview } from "./overviewView.js";
import { PromptDebugger } from "./promptDebugger.js";
import { RunComparison } from "./runComparison.js";
import { RunDashboard } from "./runDashboard.js";
import {
  RunListBreakdown,
  RunListItem,
  StatusTag,
  type StatusFilter,
} from "./runInbox.js";
import {
  aggregateConsoleRuns,
  isExactRunStatusFilter,
  isTerminal,
  summarizeRuns,
} from "./timelineCore.js";
import {
  formatCountName,
  formatDuration,
  formatRelative,
  shortId,
  titleCase,
} from "./consoleFormat.js";
import { Timeline } from "./timelineView.js";
import type {
  RunKind,
  RunListAggregate,
  RunSnapshot,
  RunSummary,
} from "./types.js";

const detailTabs = [
  { id: "overview", label: "Overview", icon: <Activity /> },
  { id: "timeline", label: "Timeline", icon: <Clock3 /> },
  { id: "models", label: "Debugger", icon: <Bot /> },
  { id: "compare", label: "Compare", icon: <SlidersHorizontal /> },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare /> },
  { id: "artifacts", label: "Artifacts", icon: <FileText /> },
  { id: "raw", label: "Raw", icon: <FileText /> },
] as const;

const PaymentsDashboard = lazy(() =>
  import("./paymentsDashboard.js").then((module) => ({
    default: module.PaymentsDashboard,
  })),
);

export function App() {
  return window.location.pathname === "/payments" ? (
    <Suspense fallback={<Loading label="Loading payments" />}>
      <PaymentsDashboard />
    </Suspense>
  ) : (
    <RunConsole />
  );
}

function RunConsole() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runAggregate, setRunAggregate] = useState<RunListAggregate | null>(
    null,
  );
  const [selectedRunId, setSelectedRunId] = useState(
    () => readConsoleUrlState().runId,
  );
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>(
    () => readConsoleUrlState().filter,
  );
  const [kind, setKind] = useState<RunKind | "all">(
    () => readConsoleUrlState().kind,
  );
  const [query, setQuery] = useState(() => readConsoleUrlState().query);
  const [tab, setTab] = useState<DetailTab>(() => readConsoleUrlState().tab);
  const [includeEmbeddings, setIncludeEmbeddings] = useState(
    () => readConsoleUrlState().includeEmbeddings,
  );
  const [terminalQuery, setTerminalQuery] = useState("");
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [jumpError, setJumpError] = useState<string | null>(null);
  const [jumpResolving, setJumpResolving] = useState(false);
  const jumpInputRef = useRef<HTMLInputElement | null>(null);

  const currentUrlState = useCallback(
    (): ConsoleUrlState => ({
      runId: selectedRunId,
      tab,
      filter,
      kind,
      query,
      includeEmbeddings,
    }),
    [selectedRunId, tab, filter, kind, query, includeEmbeddings],
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
    [applyConsoleState, currentUrlState],
  );

  const loadRuns = useCallback(async () => {
    setLoadingRuns(true);
    setError(null);
    try {
      const nextList = await fetchRunList({ includeEmbeddings });
      setRuns(nextList.runs);
      setRunAggregate(nextList.aggregate);
      if (!selectedRunId && nextList.runs[0]) {
        updateConsoleState({ runId: nextList.runs[0].runId }, "replace");
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
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
        if (!disposed)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
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
      },
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
      if (
        filter === "attention" &&
        run.status !== "failed" &&
        run.status !== "cancelled" &&
        run.status !== "no_changes"
      )
        return false;
      if (isExactRunStatusFilter(filter) && run.status !== filter) return false;
      if (!normalizedQuery) return true;
      return [
        run.runId,
        run.traceId,
        run.title,
        run.summary,
        run.requester,
        run.currentStep,
        run.kind,
        run.status,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [runs, filter, includeEmbeddings, kind, query]);

  const selectedRun =
    snapshot?.run ?? runs.find((run) => run.runId === selectedRunId) ?? null;
  const summary = summarizeRuns(runs, includeEmbeddings, runAggregate);
  const visibleAggregate = aggregateConsoleRuns(filteredRuns);

  function selectRun(runId: string) {
    updateConsoleState({ runId });
  }

  function changeKind(nextKind: RunKind | "all") {
    updateConsoleState({
      kind: nextKind,
      includeEmbeddings: nextKind === "embedding" ? true : includeEmbeddings,
    });
  }

  function changeIncludeEmbeddings(nextIncludeEmbeddings: boolean) {
    updateConsoleState({
      includeEmbeddings: nextIncludeEmbeddings,
      kind: !nextIncludeEmbeddings && kind === "embedding" ? "all" : kind,
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
        if (current.some((run) => run.runId === resolution.run.runId))
          return current;
        return [resolution.run, ...current];
      });
      updateConsoleState({
        runId: resolution.run.runId,
        includeEmbeddings:
          includeEmbeddings || resolution.run.kind === "embedding",
      });
      setJumpOpen(false);
      setJumpValue("");
    } catch (resolveError) {
      setJumpError(
        resolveError instanceof Error
          ? resolveError.message
          : String(resolveError),
      );
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
              <a className="ops-nav-link" href="/payments">
                Payments
              </a>
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
              <Button.Icon
                title="Refresh runs"
                variant="surface"
                onClick={() => void loadRuns()}
              >
                <RefreshCw />
              </Button.Icon>
            </div>
          </header>

          <section className="summary-strip" aria-label="Run summary">
            <Metric
              label="Active"
              value={summary.active}
              tone={summary.active > 0 ? "info" : "normal"}
            />
            <Metric
              label="Attention"
              value={summary.attention}
              tone={summary.attention > 0 ? "bad" : "normal"}
            />
            <Metric
              label="Code"
              value={summary.codegen}
              tone={summary.codegen > 0 ? "good" : "normal"}
            />
          </section>
          <RunDashboard runs={filteredRuns} />

          <label className="search-field">
            <Search />
            <input
              value={query}
              onChange={(event) =>
                updateConsoleState({ query: event.target.value }, "replace")
              }
              placeholder="Search runs, traces, users"
            />
          </label>

          <div className="filter-row" aria-label="Run status filters">
            {statusFilters.map((value) => (
              <button
                key={value}
                className={filter === value ? "filter active" : "filter"}
                type="button"
                onClick={() => updateConsoleState({ filter: value })}
              >
                {formatCountName(value)}
              </button>
            ))}
          </div>

          <section className="sidebar-settings" aria-label="Run list settings">
            <div className="select-control">
              <Filter />
              <select
                value={kind}
                onChange={(event) =>
                  changeKind(event.target.value as RunKind | "all")
                }
                aria-label="Run kind"
              >
                {runKinds.map((runKind) => (
                  <option key={runKind} value={runKind}>
                    {runKind === "all" ? "All kinds" : titleCase(runKind)}
                  </option>
                ))}
              </select>
            </div>
            <label
              className={includeEmbeddings ? "toggle-row active" : "toggle-row"}
            >
              <input
                type="checkbox"
                checked={includeEmbeddings}
                onChange={(event) =>
                  changeIncludeEmbeddings(event.target.checked)
                }
              />
              <span>Include embeddings</span>
              {!includeEmbeddings && summary.hiddenEmbeddings > 0 && (
                <small>{summary.hiddenEmbeddings} hidden</small>
              )}
            </label>
          </section>

          <RunListBreakdown
            aggregate={visibleAggregate}
            onStatus={(nextStatus) =>
              updateConsoleState({ filter: nextStatus })
            }
            onKind={changeKind}
            selectedStatus={filter}
            selectedKind={kind}
          />

          <section className="run-list" aria-live="polite">
            {loadingRuns && runs.length === 0 ? (
              <Loading label="Loading runs" />
            ) : filteredRuns.length === 0 ? (
              <Empty
                label={
                  includeEmbeddings
                    ? "No runs match these filters"
                    : "No runs match. Embedding runs are hidden."
                }
              />
            ) : (
              filteredRuns.map((run) => (
                <RunListItem
                  key={run.runId}
                  run={run}
                  selected={run.runId === selectedRunId}
                  onSelect={() => selectRun(run.runId)}
                />
              ))
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
                    <Tabs
                      active={tab}
                      aria-label="Run detail sections"
                      onChange={(nextTab) =>
                        updateConsoleState({ tab: nextTab as DetailTab })
                      }
                      tabs={detailTabs}
                    />
                  </div>
                  {tab === "overview" && <Overview snapshot={snapshot} />}
                  {tab === "timeline" && <Timeline snapshot={snapshot} />}
                  {tab === "models" && <PromptDebugger snapshot={snapshot} />}
                  {tab === "compare" && (
                    <RunComparison current={snapshot} runs={runs} />
                  )}
                  {tab === "terminal" && (
                    <TerminalView
                      terminal={snapshot.terminal}
                      query={terminalQuery}
                      onQueryChange={setTerminalQuery}
                    />
                  )}
                  {tab === "artifacts" && (
                    <ArtifactsView
                      runId={snapshot.run.runId}
                      artifacts={snapshot.artifacts}
                    />
                  )}
                  {tab === "raw" && <RawView snapshot={snapshot} />}
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
          {loading && (
            <Tag dot intent="info">
              syncing
            </Tag>
          )}
        </div>
        <h2>{run.title}</h2>
        <p>{run.summary ?? run.currentStep ?? run.runId}</p>
        <div className="run-meta-row">
          <MetaPill
            icon={<Clock3 />}
            label="Duration"
            value={formatDuration(run.durationMs)}
          />
          <MetaPill
            icon={<Activity />}
            label="Updated"
            value={formatRelative(run.updatedAt)}
          />
          {run.requester && (
            <MetaPill icon={<Bot />} label="Requester" value={run.requester} />
          )}
          {run.traceId && (
            <MetaPill
              icon={<Link2 />}
              label="Trace"
              value={shortId(run.traceId)}
              copyValue={run.traceId}
            />
          )}
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
  onSubmit,
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
      <section
        className="jump-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Jump to run"
        onMouseDown={(event) => event.stopPropagation()}
      >
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
          <span>
            Paste a Discord `/channels/.../.../...` link or raw message id.
          </span>
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
