export type OperatorActivitySource = {
  id: string;
  kind: "runtime" | "system";
  title: string;
  authorLabel: string | null;
  status: string | null;
  detail: string | null;
  occurredAt: Date;
  startedAt: Date;
  durationMs: number | null;
  attempts: number | null;
  eventCount: number;
  rollupKey: string | null;
  responseStatus: string | null;
  deliveryState: string | null;
  sourceUrl: string | null;
  responseUrl: string | null;
  responseKind: string | null;
  hasParent: boolean;
  events: Array<{ id: string; name: string; level: string; createdAt: Date }>;
};

export function projectActivitySources(runtimeRows: Array<Record<string, unknown>>): OperatorActivitySource[] {
  const groups = new Map<string, OperatorActivitySource>();
  for (const row of runtimeRows) {
    const key = `runtime-${row.execution_id}`;
    const occurredAt = date(row.story_updated_at);
    const startedAt = date(row.story_started_at);
    const group: OperatorActivitySource = groups.get(key) ?? {
      id: key, kind: row.is_system ? "system" : "runtime", title: String(row.title),
      authorLabel: nullable(row.source_author_label), status: nullable(row.status), detail: null,
      occurredAt, startedAt, durationMs: Math.max(0, occurredAt.getTime() - startedAt.getTime()),
      attempts: number(row.attempt) || 1, eventCount: number(row.group_event_count) || 1,
      rollupKey: nullable(row.rollup_key), responseStatus: nullable(row.response_status),
      deliveryState: nullable(row.delivery_state),
      sourceUrl: discordUrl(row.delivery_guild_id, row.delivery_channel_id, row.source_message_id),
      responseUrl: discordUrl(row.delivery_guild_id, row.status_channel_id, row.status_message_id),
      responseKind: row.status_message_id == null ? null : "reply", hasParent: Boolean(row.has_parent),
      events: [],
    };
    if (row.id != null && group.events.length < 12) group.events.push({
      id: `runtime-event-${row.id}`, name: String(row.event_name), level: String(row.level), createdAt: date(row.created_at),
    });
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
}

function nullable(value: unknown): string | null { return value == null ? null : String(value); }
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)); }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function discordUrl(guildId: unknown, channelId: unknown, messageId: unknown): string | null {
  if (guildId == null || channelId == null || messageId == null) return null;
  return `https://discord.com/channels/${encodeURIComponent(String(guildId))}/${encodeURIComponent(String(channelId))}/${encodeURIComponent(String(messageId))}`;
}
