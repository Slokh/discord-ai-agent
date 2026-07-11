import { Tag } from "regen-ui";
import type { RunCount, RunKind, RunListAggregate, RunStatus, RunSummary } from "./types.js";

export type StatusFilter = "all" | "active" | "done" | "attention" | RunStatus;

export function RunListItem({ run, selected, onSelect }: { run: RunSummary; selected: boolean; onSelect: () => void }) {
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

export function StatusTag({ status }: { status: RunStatus }) {
  const intent = status === "succeeded" ? "positive" : status === "failed" || status === "cancelled" ? "negative" : status === "no_changes" ? "warning" : "accent";
  return <Tag dot intent={intent}>{status}</Tag>;
}

export function RunListBreakdown({
  aggregate,
  selectedStatus,
  selectedKind,
  onStatus,
  onKind
}: {
  aggregate: RunListAggregate;
  selectedStatus: StatusFilter;
  selectedKind: RunKind | "all";
  onStatus: (status: StatusFilter) => void;
  onKind: (kind: RunKind | "all") => void;
}) {
  return (
    <section className="run-breakdown" aria-label="Visible run breakdown">
      <div className="run-breakdown-header"><span>Visible</span><strong>{aggregate.total}</strong></div>
      <CountChips label="Status" counts={aggregate.byStatus} selected={selectedStatus} onSelect={(name) => onStatus(isRunStatus(name) ? name : "all")} />
      <CountChips label="Kind" counts={aggregate.byKind} selected={selectedKind} onSelect={(name) => onKind(isRunKind(name) ? name : "all")} />
      {aggregate.codegenDiagnoses.length > 0 && <CountChips label="Codegen diagnosis" counts={aggregate.codegenDiagnoses} selected="" />}
    </section>
  );
}

function CountChips({ label, counts, selected, onSelect }: { label: string; counts: RunCount[]; selected: string; onSelect?: (name: string) => void }) {
  if (counts.length === 0) return null;
  return (
    <div className="count-chip-group">
      <span>{label}</span>
      <div>
        {counts.slice(0, 6).map((item) => {
          const content = <><span>{formatCountName(item.name)}</span><strong>{item.count}</strong></>;
          return onSelect ? (
            <button key={item.name} className={selected === item.name ? "count-chip active" : "count-chip"} type="button" onClick={() => onSelect(item.name)}>{content}</button>
          ) : <span key={item.name} className="count-chip">{content}</span>;
        })}
      </div>
    </div>
  );
}

function isRunStatus(value: string): value is RunStatus {
  return ["queued", "running", "succeeded", "failed", "cancelled", "no_changes"].includes(value);
}

function isRunKind(value: string): value is RunKind {
  return ["agent", "codegen", "discord", "embedding", "system"].includes(value);
}

function formatCountName(value: string) {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatRelative(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(delta)) return value;
  if (delta < 60_000) return `${Math.max(0, Math.round(delta / 1_000))}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function formatDuration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "--";
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}
