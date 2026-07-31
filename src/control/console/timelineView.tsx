import { Clock3, Link2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { codegenTimelineTrace } from "./codegenTimeline.js";
import { Empty, MetadataPreview } from "./consolePrimitives.js";
import { runHref } from "./consoleRouting.js";
import {
  eventsWithTiming,
  formatBytes,
  formatDate,
  formatDuration,
  titleCase,
} from "./consoleFormat.js";
import {
  agentTranscriptToolRequests,
  buildTimelineTrace,
  conversationFlow,
  relatedRunTimelineSteps,
  timelineStart,
  timelineStepIcon,
  timelineStepLabel,
  timelineTrace,
  uniqueStrings,
} from "./timelineCore.js";
import { type TimelineStep, type TimelineStepGroup } from "./timelineModel.js";
import {
  formatToolArgumentValue,
  isModelRoundTimelineStep,
  parseToolArgumentsText,
  timelineStepSummaryText,
  timelineTitleText,
  timelineToolRequests,
  type TimelineToolRequest,
} from "./timelineText.js";
import { TimelineArtifactInline } from "./transcriptViews.js";
import type { EventLevel, RunSnapshot } from "./types.js";

export {
  timelineStepSummaryText,
  timelineSummaryText,
  timelineTitleText,
  timelineToolRequests,
} from "./timelineText.js";

export function Timeline({ snapshot }: { snapshot: RunSnapshot }) {
  const [level, setLevel] = useState<EventLevel | "all">("all");
  const [source, setSource] = useState<string>("all");
  const flowItems = useMemo(() => conversationFlow(snapshot), [snapshot]);
  const relatedRuns = useMemo(
    () => snapshot.relatedRuns ?? [],
    [snapshot.relatedRuns],
  );
  const sources = useMemo(
    () =>
      uniqueStrings([
        ...snapshot.events.map((event) => event.source),
        ...snapshot.spans.map((span) => span.source),
        ...flowItems.map((item) => item.source),
        ...relatedRuns.map(() => "related run"),
      ]).sort(),
    [snapshot.events, snapshot.spans, flowItems, relatedRuns],
  );
  const events = snapshot.events.filter((event) => {
    if (level !== "all" && event.level !== level) return false;
    if (source !== "all" && event.source !== source) return false;
    return true;
  });
  const spans = snapshot.spans.filter((span) => {
    if (source !== "all" && span.source !== source) return false;
    if (level === "error")
      return span.status === "failed" || span.status === "cancelled";
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
    if (level === "error")
      return run.status === "failed" || run.status === "cancelled";
    if (level === "warn") return run.status === "no_changes";
    return true;
  });
  const timelineStartedAt = timelineStart(
    snapshot.run.startedAt,
    events,
    spans,
    flows,
  );
  const timedEvents = eventsWithTiming(events, timelineStartedAt);
  const baseTrace =
    codegenTimelineTrace(snapshot, {
      events,
      spans,
      startedAt: timelineStartedAt,
    }) ??
    timelineTrace({
      events: timedEvents,
      spans,
      flows,
      startedAt: timelineStartedAt,
    });
  const relatedSteps = relatedRunTimelineSteps(visibleRelatedRuns, {
    startedAt: timelineStartedAt,
    generatedAt: snapshot.generatedAt,
  });
  const trace =
    relatedSteps.length > 0
      ? buildTimelineTrace([...baseTrace.steps, ...relatedSteps])
      : baseTrace;

  return (
    <section className="panel detail-panel">
      <div className="panel-heading">
        <div className="panel-title">
          <Clock3 />
          <h3>Timeline</h3>
        </div>
        <div className="mini-controls">
          <select
            value={level}
            onChange={(event) =>
              setLevel(event.target.value as EventLevel | "all")
            }
            aria-label="Timeline severity filter"
          >
            <option value="all">All levels</option>
            <option value="info">Info</option>
            <option value="warn">Warnings</option>
            <option value="error">Errors</option>
            <option value="debug">Debug</option>
          </select>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            aria-label="Timeline source filter"
          >
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
              <TimelineGroupItems key={group.id} group={group} />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function TimelineGroupItems({ group }: { group: TimelineStepGroup }) {
  return <TimelineGroupItem group={group} />;
}

function TimelineGroupItem({ group }: { group: TimelineStepGroup }) {
  return (
    <li
      className={`timeline-step ${group.parent.kind} ${group.parent.level ?? group.parent.status ?? ""}`}
    >
      <div className="timeline-rail">
        <div className="timeline-dot" />
      </div>
      <article className="timeline-card">
        <TimelineStepHeader step={group.parent} />
        <TimelineStepDetails step={group.parent} />
        <TimelineStepMeta step={group.parent} />
        {group.parent.artifact && (
          <TimelineArtifactInline artifact={group.parent.artifact} />
        )}
        {group.children.length > 0 && (
          <div className="timeline-children">
            {group.children.map((child) => (
              <article
                key={child.id}
                className={`timeline-child ${child.kind} ${child.level ?? child.status ?? ""}`}
              >
                <TimelineStepHeader step={child} child />
                <TimelineStepDetails step={child} />
                <TimelineStepMeta step={child} />
                {child.artifact && (
                  <TimelineArtifactInline artifact={child.artifact} />
                )}
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
  const transcriptRequests = agentTranscriptToolRequests(step);
  if (transcriptRequests.length > 0)
    return <RequestedTools requests={transcriptRequests} />;
  const toolRequests = timelineToolRequests(step);
  if (isModelRoundTimelineStep(step) && toolRequests.length > 0)
    return <RequestedTools requests={toolRequests} />;
  const summary = timelineStepSummaryText(step);
  return summary ? <p>{summary}</p> : null;
}

function RelatedRunInline({ step }: { step: TimelineStep }) {
  const runId =
    typeof step.metadata.runId === "string" ? step.metadata.runId : "";
  return (
    <div className="related-run-inline">
      {step.summary && <p>{step.summary}</p>}
      {runId && (
        <a href={runHref(runId, "timeline")}>
          Open {step.metadata.kind === "codegen" ? "codegen" : "related"}{" "}
          timeline
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
          <div
            className="requested-tool"
            key={`${request.id ?? request.name}-${index}`}
          >
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
  if (!argumentsText?.trim())
    return <span className="tool-args-empty">no args</span>;
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

function TimelineStepHeader({
  step,
  child = false,
}: {
  step: TimelineStep;
  child?: boolean;
}) {
  return (
    <div className={child ? "timeline-child-title" : "timeline-title"}>
      <span className={`timeline-icon ${step.kind}`}>
        {timelineStepIcon(step.kind)}
      </span>
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
      <span className={`timeline-kind ${step.kind}`}>
        {timelineStepLabel(step.kind)}
      </span>
      <span>{formatDate(step.createdAt)}</span>
      {step.level && (
        <span className={`level-text ${step.level}`}>{step.level}</span>
      )}
      {step.status && (
        <span className={`level-text ${step.status}`}>{step.status}</span>
      )}
      {step.artifact && <span>{formatBytes(step.artifact.sizeBytes)}</span>}
    </div>
  );
}
