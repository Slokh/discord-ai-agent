import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Search, TerminalSquare } from "lucide-react";
import { Button, Copy } from "regen-ui";
import { fetchArtifact } from "./api.js";
import type { RunArtifact, RunSnapshot, TerminalEntry } from "./types.js";

type TerminalStream = TerminalEntry["stream"];
const streamLabels: Record<TerminalStream, string> = { command: "Commands", stdout: "stdout", stderr: "stderr", exit: "Exits" };

export function TerminalView({ terminal, query, onQueryChange }: { terminal: RunSnapshot["terminal"]; query: string; onQueryChange: (value: string) => void }) {
  const [step, setStep] = useState("all");
  const [streams, setStreams] = useState<Record<TerminalStream, boolean>>({ command: true, stdout: true, stderr: true, exit: true });
  const steps = useMemo(() => [...new Set(terminal.entries.map((entry) => entry.step))].sort(), [terminal.entries]);
  useEffect(() => { if (step !== "all" && !steps.includes(step)) setStep("all"); }, [step, steps]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = terminal.entries.filter((entry) => streams[entry.stream] && (step === "all" || entry.step === step) && (!normalizedQuery || [entry.content, entry.step, entry.command, entry.stream].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalizedQuery))));
  const content = visible.map((entry) => entry.content).join("\n\n");
  return <section className="panel terminal-panel detail-panel"><div className="panel-heading"><div className="panel-title"><TerminalSquare /><h3>Terminal</h3></div><div className="terminal-actions"><Copy value={content} title="Copy visible terminal output" /><Button.Icon title="Download visible terminal output" variant="surface" onClick={() => downloadText("run-terminal.log", content)}><Download /></Button.Icon></div></div><div className="terminal-controls"><label className="terminal-search"><Search /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search terminal output" /></label><select className="terminal-source" value={step} onChange={(event) => setStep(event.target.value)} aria-label="Terminal command filter"><option value="all">All commands</option>{steps.map((item) => <option key={item} value={item}>{item}</option>)}</select><div className="stream-toggle-row" aria-label="Terminal stream filters">{(Object.keys(streamLabels) as TerminalStream[]).map((stream) => <label key={stream} className={streams[stream] ? "stream-toggle active" : "stream-toggle"}><input type="checkbox" checked={streams[stream]} onChange={(event) => setStreams((current) => ({ ...current, [stream]: event.target.checked }))}/>{streamLabels[stream]}</label>)}</div></div>{content ? <pre className="terminal-output">{content}</pre> : <p className="empty">No terminal output matches these filters</p>}</section>;
}

export function ArtifactsView({ runId, artifacts }: { runId: string; artifacts: RunArtifact[] }) {
  const [selectedId, setSelectedId] = useState(artifacts[0]?.artifactId ?? "");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const selected = artifacts.find((artifact) => artifact.artifactId === selectedId) ?? artifacts[0] ?? null;
  useEffect(() => { if (!selectedId || !artifacts.some((artifact) => artifact.artifactId === selectedId)) setSelectedId(artifacts[0]?.artifactId ?? ""); }, [artifacts, selectedId]);
  useEffect(() => { if (!selected) { setContent(""); return; } setLoading(true); void fetchArtifact(runId, selected.artifactId).then(setContent).catch((error) => setContent(error instanceof Error ? error.message : String(error))).finally(() => setLoading(false)); }, [runId, selected]);
  return <section className="artifact-layout"><aside className="panel artifact-list"><div className="panel-title"><FileText /><h3>Artifacts</h3></div>{artifacts.length === 0 ? <p className="empty">No artifacts yet</p> : artifacts.map((artifact) => <button key={artifact.artifactId} className={selected?.artifactId === artifact.artifactId ? "artifact-item active" : "artifact-item"} onClick={() => setSelectedId(artifact.artifactId)} type="button"><span>{artifact.name}</span><small>{artifact.kind} - {formatBytes(artifact.sizeBytes)}</small></button>)}</aside><section className="panel artifact-content"><div className="panel-heading"><div className="panel-title"><FileText /><h3>{selected?.name ?? "Artifact"}</h3></div>{selected && <Copy value={content || selected.preview} title="Copy artifact" />}</div>{loading ? <p className="loading">Loading artifact</p> : <pre>{content || selected?.preview || ""}</pre>}</section></section>;
}

export function RawView({ snapshot }: { snapshot: RunSnapshot }) { return <section className="panel terminal-panel detail-panel"><div className="panel-title"><FileText /><h3>Raw Snapshot</h3></div><pre className="terminal-output">{JSON.stringify(snapshot, null, 2)}</pre></section>; }

function formatBytes(bytes: number) { return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`; }
function downloadText(name: string, content: string) { const url = URL.createObjectURL(new Blob([content], { type: "text/plain" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); }
