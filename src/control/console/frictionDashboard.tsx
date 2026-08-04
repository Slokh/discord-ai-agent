import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Tag } from "regen-ui";
import { fetchFrictionSnapshot, type FrictionSnapshot } from "./api.js";
import { Empty, Loading, Metric } from "./consolePrimitives.js";
import { shortId, titleCase } from "./consoleFormat.js";

export function FrictionDashboard() {
  const [snapshot, setSnapshot] = useState<FrictionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setSnapshot(await fetchFrictionSnapshot()); setError(null); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <main className="payments-console">
    <header className="payments-header"><div><p className="eyebrow">Agent Ops</p><h1>Private friction</h1><p className="payments-subtitle">Content-free summaries of reusable impediments reported by normal reply agents.</p></div>
      <div className="sidebar-actions"><a className="ops-nav-link" href="/runs">Runs</a><a className="ops-nav-link" href="/payments">Payments</a><Button.Icon title="Refresh friction" variant="surface" onClick={() => void load()}><RefreshCw /></Button.Icon></div>
    </header>
    {error && <div className="notice bad"><AlertCircle /><span>{error}</span></div>}
    {!snapshot ? <Loading label="Loading friction" /> : <>
      <section className="payments-metrics"><Metric label="Open entries" value={snapshot.items.length} tone={snapshot.items.length ? "info" : "normal"} />
        {snapshot.bySeverity.map((item) => <Metric key={item.name} label={titleCase(item.name)} value={item.count} tone={item.name === "blocker" ? "bad" : "normal"} />)}
      </section>
      <section className="panel payments-panel"><div className="panel-heading"><div className="panel-title"><h3>Entries</h3></div><span>Bodies remain available only through the private Frog operator command.</span></div>
        {!snapshot.items.length ? <Empty label="No reusable friction has been reported." /> : <div className="payments-table-wrap"><table className="payments-table"><thead><tr><th>Category</th><th>Severity</th><th>Capability</th><th>Occurrences</th><th>Revision</th><th>Run</th></tr></thead><tbody>
          {snapshot.items.map((item) => <tr key={item.id}><td>{titleCase(item.category)}</td><td><Tag>{item.severity}</Tag></td><td>{item.affectedCapability ?? "—"}</td><td>{item.occurrences}</td><td>{item.appRevision ? shortId(item.appRevision) : "—"}</td><td>{item.executionId ? <a href={`/runs/${encodeURIComponent(item.executionId)}`}>{shortId(item.executionId)}</a> : "—"}</td></tr>)}
        </tbody></table></div>}
      </section>
    </>}
  </main>;
}
