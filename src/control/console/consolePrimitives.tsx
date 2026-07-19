import type { ReactNode } from "react";
import { Copy, Status } from "regen-ui";
import { metadataValue } from "./consoleFormat.js";

export function Metric({
  label,
  value,
  tone = "normal",
}: {
  label: string;
  value: string | number;
  tone?: "normal" | "bad" | "good" | "info";
}) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function MetaPill({
  icon,
  label,
  value,
  copyValue,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  copyValue?: string;
}) {
  return (
    <span className="meta-pill">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
      {copyValue && <Copy value={copyValue} title={`Copy ${label}`} />}
    </span>
  );
}

export function MetadataPreview({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
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

export function Loading({ label }: { label: string }) {
  return (
    <div className="state">
      <Status type="loading" />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ label }: { label: string }) {
  return (
    <div className="state empty">
      <Status type="info" />
      <span>{label}</span>
    </div>
  );
}
