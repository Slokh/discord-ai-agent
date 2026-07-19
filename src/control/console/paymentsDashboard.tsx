import { AlertCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Tag } from "regen-ui";
import { fetchPaymentsSnapshot, type PaymentsSnapshot } from "./api.js";
import { Empty, Loading, Metric } from "./consolePrimitives.js";
import { formatRelative, shortId } from "./consoleFormat.js";

export function PaymentsDashboard() {
  const [snapshot, setSnapshot] = useState<PaymentsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await fetchPaymentsSnapshot());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  const botHealth = snapshot?.health?.find(
    (row) => textValue(row.health_key) === "shared_bot_wallet",
  );
  const botHealthDetails =
    botHealth?.details && typeof botHealth.details === "object"
      ? (botHealth.details as Record<string, unknown>)
      : undefined;

  return (
    <main className="payments-console">
      <header className="payments-header">
        <div>
          <p className="eyebrow">Agent Ops</p>
          <h1>Wallets & payments</h1>
          <p className="payments-subtitle">
            Provisioning, transfers, and wagers from the durable wallet ledger.
          </p>
        </div>
        <div className="sidebar-actions">
          <a className="ops-nav-link" href="/runs">
            Runs
          </a>
          <Button.Icon
            title="Refresh payments"
            variant="surface"
            onClick={() => void load()}
          >
            <RefreshCw />
          </Button.Icon>
        </div>
      </header>
      {error && (
        <div className="notice bad">
          <AlertCircle />
          <span>{error}</span>
        </div>
      )}
      {loading && !snapshot ? (
        <Loading label="Loading payment state" />
      ) : (
        snapshot && (
          <>
            <section className="payments-metrics">
              <Metric
                label="Wallets"
                value={Number(snapshot.totals.wallets ?? 0)}
                tone="normal"
              />
              <Metric
                label="Wallet errors"
                value={Number(snapshot.totals.wallet_errors ?? 0)}
                tone={
                  Number(snapshot.totals.wallet_errors ?? 0) > 0
                    ? "bad"
                    : "normal"
                }
              />
              <Metric
                label="Pending transfers"
                value={Number(snapshot.totals.transfers_pending ?? 0)}
                tone={
                  Number(snapshot.totals.transfers_pending ?? 0) > 0
                    ? "info"
                    : "normal"
                }
              />
              <Metric
                label="Open wagers"
                value={Number(snapshot.totals.wagers_open ?? 0)}
                tone={
                  Number(snapshot.totals.wagers_open ?? 0) > 0
                    ? "info"
                    : "normal"
                }
              />
              <Metric
                label="Awaiting players"
                value={Number(snapshot.totals.games_awaiting_action ?? 0)}
                tone={
                  Number(snapshot.totals.games_awaiting_action ?? 0) > 0
                    ? "info"
                    : "normal"
                }
              />
              <Metric
                label="Bot wallet"
                value={
                  botHealthDetails?.balanceUsd != null
                    ? `$${textValue(botHealthDetails.balanceUsd)}`
                    : "—"
                }
                tone={
                  textValue(botHealth?.status) === "low_balance"
                    ? "bad"
                    : "normal"
                }
              />
            </section>
            <PaymentsTable
              title="Wallets"
              rows={snapshot.wallets}
              columns={[
                [
                  "owner",
                  (row) =>
                    `${textValue(row.owner_kind)}${row.discord_user_id ? ` · ${shortId(textValue(row.discord_user_id))}` : ""}`,
                ],
                ["status", (row) => textValue(row.status)],
                ["address", (row) => shortAddress(textValue(row.address))],
                ["chain", (row) => textValue(row.chain_id)],
                ["updated", (row) => formatRelative(textValue(row.updated_at))],
              ]}
            />
            <PaymentsTable
              title="Transfers"
              rows={snapshot.transfers}
              columns={[
                ["purpose", (row) => textValue(row.purpose)],
                [
                  "amount",
                  (row) =>
                    `$${formatAtomic(textValue(row.amount_atomic), Number(row.token_decimals ?? 6))} USD`,
                ],
                ["status", (row) => textValue(row.status)],
                ["tx", (row) => shortId(textValue(row.transaction_hash))],
                ["created", (row) => formatRelative(textValue(row.created_at))],
              ]}
            />
            <PaymentsTable
              title="Wagers"
              rows={snapshot.wagers}
              columns={[
                ["game", (row) => textValue(row.game)],
                [
                  "stake",
                  (row) =>
                    `$${formatAtomic(textValue(row.stake_atomic), Number(row.token_decimals ?? 6))}`,
                ],
                [
                  "max payout",
                  (row) =>
                    `$${formatAtomic(textValue(row.max_payout_atomic), Number(row.token_decimals ?? 6))}`,
                ],
                ["status", (row) => textValue(row.status)],
                [
                  "state",
                  (row) =>
                    row.awaiting_action
                      ? `v${textValue(row.state_version)} · ${arrayText(row.allowed_actions)} · ${jsonPreview(row.decision_state)}`
                      : "—",
                ],
                ["prompt", (row) => textValue(row.action_prompt)],
                ["draw", (row) => textValue(row.draw_id)],
              ]}
            />
          </>
        )
      )}
    </main>
  );
}

function PaymentsTable({
  title,
  rows,
  columns,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
  columns: Array<[string, (row: Record<string, unknown>) => string]>;
}) {
  return (
    <section className="panel payments-panel">
      <div className="panel-heading">
        <h3>{title}</h3>
        <Tag intent="neutral">{rows.length}</Tag>
      </div>
      {rows.length === 0 ? (
        <Empty label={`No ${title.toLowerCase()} recorded`} />
      ) : (
        <div className="payments-table-wrap">
          <table className="payments-table">
            <thead>
              <tr>
                {columns.map(([label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={textValue(row.id) || index}>
                  {columns.map(([label, render]) => (
                    <td key={label}>{render(row) || "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function formatAtomic(value: string, decimals: number) {
  if (!/^\d+$/.test(value)) return "—";
  const padded = value.padStart(decimals + 1, "0");
  const whole = decimals > 0 ? padded.slice(0, -decimals) : padded;
  const fraction =
    decimals > 0 ? padded.slice(-decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function textValue(value: unknown): string {
  return value == null ? "" : String(value);
}

function arrayText(value: unknown): string {
  return Array.isArray(value)
    ? value.map(textValue).filter(Boolean).join(", ")
    : textValue(value);
}

function jsonPreview(value: unknown): string {
  const rendered = JSON.stringify(value ?? {});
  return rendered.length > 140 ? `${rendered.slice(0, 139)}…` : rendered;
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}
