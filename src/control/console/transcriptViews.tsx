import { AlertCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  parseOpenCodeTranscript,
  type ParsedOpenCodeTranscript,
} from "../../observability/openCodeTranscript.js";
import { fetchArtifact } from "./api.js";
import { parseCodexTranscript } from "./codexTranscript.js";
import {
  isCodexTranscriptArtifact,
  isOpenCodeTranscriptArtifact,
} from "./codegenArtifacts.js";
import { Metric } from "./consolePrimitives.js";
import { formatDate, formatDuration } from "./consoleFormat.js";
import type { RunArtifact } from "./types.js";

type OpenCodeTranscriptItem = ParsedOpenCodeTranscript["items"][number];

export function TimelineArtifactInline({
  artifact,
}: {
  artifact: RunArtifact;
}) {
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
        if (!disposed)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [artifact.artifactId, artifact.runId]);

  const visibleContent = content || artifact.preview;
  const waitForFullOpenCodeArtifact =
    isOpenCodeTranscriptArtifact(artifact) && !content && loading;
  return (
    <>
      {loading && (
        <span className="timeline-artifact-loading">
          Loading full artifact...
        </span>
      )}
      {error && (
        <div className="jump-error">
          <AlertCircle />
          <span>{error}</span>
        </div>
      )}
      {waitForFullOpenCodeArtifact ? null : isOpenCodeTranscriptArtifact(
          artifact,
        ) ? (
        <OpenCodeTranscript content={visibleContent} />
      ) : isCodexTranscriptArtifact(artifact) ? (
        <CodexTranscript content={visibleContent} />
      ) : (
        <pre className="timeline-artifact-code">{visibleContent}</pre>
      )}
    </>
  );
}

function OpenCodeTranscript({ content }: { content: string }) {
  const transcript = useMemo(() => parseOpenCodeTranscript(content), [content]);
  if (!transcript.isTranscript)
    return <pre className="timeline-artifact-code">{content}</pre>;
  return (
    <div className="codex-transcript opencode-transcript">
      <div className="codex-transcript-summary">
        <Metric label="Rounds" value={transcript.rounds} />
        <Metric
          label="Total"
          value={
            transcript.totalDurationMs == null
              ? "unknown"
              : formatDuration(transcript.totalDurationMs)
          }
        />
        <Metric
          label="Model wait"
          value={
            transcript.modelWaitMs == null
              ? "unknown"
              : formatDuration(transcript.modelWaitMs)
          }
        />
        <Metric
          label="Tool time"
          value={formatDuration(transcript.toolDurationMs)}
        />
        <Metric
          label="Round time"
          value={formatDuration(transcript.roundDurationMs)}
        />
        <Metric
          label="Gaps"
          value={formatDuration(transcript.interRoundGapMs)}
        />
        <Metric
          label="First edit"
          value={
            transcript.firstEditAtMs == null
              ? "none"
              : formatDuration(transcript.firstEditAtMs)
          }
        />
        <Metric
          label="Pre-edit rounds"
          value={
            transcript.roundsBeforeFirstEdit == null
              ? "unknown"
              : String(transcript.roundsBeforeFirstEdit)
          }
        />
        <Metric
          label="Tokens"
          value={
            transcript.tokenTotal == null
              ? "unknown"
              : transcript.tokenTotal.toLocaleString()
          }
        />
      </div>
      <div className="opencode-transcript-insights">
        {transcript.slowestRound && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Slowest round: {transcript.slowestRound.title}</strong>
            <span>{formatDuration(transcript.slowestRound.durationMs)}</span>
          </div>
        )}
        {transcript.interRoundGapMs > 0 && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Between-round gap</strong>
            <span>{formatDuration(transcript.interRoundGapMs)}</span>
          </div>
        )}
        {transcript.outsideRoundMs != null && transcript.outsideRoundMs > 0 && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Outside model rounds</strong>
            <span>{formatDuration(transcript.outsideRoundMs)}</span>
          </div>
        )}
        {transcript.slowestGaps.length > 0 && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Largest idle gaps</strong>
            <span>
              {transcript.slowestGaps
                .map(
                  (gap) =>
                    `${gap.afterRound}->${gap.beforeRound}: ${formatDuration(gap.durationMs)}`,
                )
                .join(", ")}
            </span>
          </div>
        )}
        {transcript.activeRound && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Active round: round {transcript.activeRound.round}</strong>
            <span>
              {formatDuration(transcript.activeRound.durationMs)} so far
              {transcript.activeRound.tools.length > 0
                ? ` · ${transcript.activeRound.tools.join(", ")}`
                : ""}
            </span>
          </div>
        )}
        {transcript.failedTools > 0 && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Failed tools</strong>
            <span>{transcript.failedTools}</span>
          </div>
        )}
        {transcript.repeatedReads.length > 0 && (
          <div className="codex-transcript-stop opencode-transcript-insight">
            <strong>Repeated reads</strong>
            <span>
              {transcript.repeatedReads
                .map((read) => `${read.title || "untitled"} x${read.count}`)
                .join(", ")}
            </span>
          </div>
        )}
      </div>
      <div className="opencode-round-timeline">
        {transcript.items.map((item) => (
          <article
            key={item.id}
            className={`opencode-round-step ${item.kind}${item.active ? " active" : ""}`}
          >
            <div className="opencode-round-rail">
              <span className="opencode-round-dot" />
            </div>
            <div
              className={`codex-transcript-item opencode-round-card ${item.kind}${item.active ? " active" : ""}`}
            >
              <div className="codex-transcript-item-head">
                <strong>{item.title}</strong>
                <span>
                  {[
                    item.active ? "running" : null,
                    item.durationMs != null
                      ? formatDuration(item.durationMs)
                      : null,
                    formatDate(item.timestamp),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <OpenCodeRoundContent item={item} />
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

export function OpenCodeRoundContent({
  item,
}: {
  item: OpenCodeTranscriptItem;
}) {
  return (
    <>
      {item.active && (
        <span className="codex-transcript-active-pill">Active round</span>
      )}
      <div className="opencode-round-metrics">
        {item.gapBeforeMs != null && item.gapBeforeMs > 0 && (
          <span>gap before {formatDuration(item.gapBeforeMs)}</span>
        )}
        {item.modelWaitMs != null && (
          <span>model wait {formatDuration(item.modelWaitMs)}</span>
        )}
        {item.toolDurationMs > 0 && (
          <span>tools {formatDuration(item.toolDurationMs)}</span>
        )}
      </div>
      {item.body && <p>{item.body}</p>}
      {item.tools.length > 0 && (
        <div className="opencode-tool-list">
          {item.tools.map((tool, index) => (
            <div
              className="opencode-tool"
              key={`${item.id}-${tool.name}-${index}`}
            >
              <div>
                <strong>{tool.name}</strong>
                {tool.status && <span>{tool.status}</span>}
                {tool.durationMs != null && (
                  <span>{formatDuration(tool.durationMs)}</span>
                )}
              </div>
              {tool.title && <code>{tool.title}</code>}
              {tool.output && <p>{tool.output}</p>}
            </div>
          ))}
        </div>
      )}
      {item.command && <code>{item.command}</code>}
      {item.output && <pre>{item.output}</pre>}
    </>
  );
}

function CodexTranscript({ content }: { content: string }) {
  const transcript = useMemo(() => parseCodexTranscript(content), [content]);
  if (!transcript.isTranscript)
    return <pre className="timeline-artifact-code">{content}</pre>;
  return (
    <div className="codex-transcript">
      <div className="codex-transcript-summary">
        <Metric label="Messages" value={transcript.agentMessages} />
        <Metric label="Commands" value={transcript.commands} />
        <Metric
          label="Reasoning"
          value={`${transcript.reasoningDeltaCount} chunks`}
        />
        <Metric
          label="Tokens"
          value={
            transcript.tokenTotal == null
              ? "unknown"
              : transcript.tokenTotal.toLocaleString()
          }
        />
      </div>
      <div className="codex-transcript-list">
        {transcript.items.map((item) => (
          <article
            key={item.id}
            className={`codex-transcript-item ${item.kind}`}
          >
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
