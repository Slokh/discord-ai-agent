import pg, { type Pool, type QueryResultRow } from "pg";

const BATCH_SIZE = 1_000;
const sourceUrl = requiredUrl("SOURCE_DATABASE_URL");
const destinationUrl = requiredUrl("DATABASE_URL");

if (sameDatabase(sourceUrl, destinationUrl)) {
  throw new Error("SOURCE_DATABASE_URL and DATABASE_URL must identify different databases.");
}

const source = new pg.Pool({ connectionString: sourceUrl, max: 2 });
const destination = new pg.Pool({ connectionString: destinationUrl, max: 2 });

type CopySpec = {
  label: string;
  sourceTable: string;
  key: string;
  select: string;
  destinationTable: string;
  columns: string[];
  conflict: string;
  map: (row: QueryResultRow) => unknown[];
};

async function main() {
  await assertDestinationReady();
  if (process.env.SKIP_ARCHIVE_COPY === "true") await finalizeCrawlCursors();
  else await copyIdentityAndArchive();
  await copyPreferencesAndPrivacy();
  await copyWalletCustody();
  process.stdout.write("Existing production data import completed.\n");
}

async function copyIdentityAndArchive() {
  const guilds = await source.query(guildIdsQuery());
  await insertRows(destination, "guilds", ["id", "name"], guilds.rows.map((row) => [row.guild_id, null]), "(id) DO NOTHING");

  await copyBatches({
    label: "Discord users",
    sourceTable: "discord_members",
    key: "user_id",
    select: "user_id, username, display_name, is_bot, deleted_at, updated_at",
    destinationTable: "discord_users",
    columns: ["id", "username", "global_name", "is_bot", "deleted_at", "updated_at"],
    conflict: "(id) DO UPDATE SET username=excluded.username, global_name=excluded.global_name, is_bot=excluded.is_bot, deleted_at=excluded.deleted_at, updated_at=excluded.updated_at",
    map: (row) => [row.user_id, row.username, row.display_name, row.is_bot, row.deleted_at, row.updated_at],
  });

  await copyBatches({
    label: "Discord members",
    sourceTable: "discord_members",
    key: "user_id",
    select: "guild_id, user_id, display_name, username, updated_at",
    destinationTable: "guild_members",
    columns: ["guild_id", "user_id", "display_name", "nickname", "updated_at"],
    conflict: "(guild_id, user_id) DO UPDATE SET display_name=excluded.display_name, nickname=excluded.nickname, updated_at=excluded.updated_at",
    map: (row) => [row.guild_id, row.user_id, row.display_name ?? row.username, null, row.updated_at],
  });

  await copyBatches({
    label: "Discord channels",
    sourceTable: "discord_channels",
    key: "channel_id",
    select: "guild_id, channel_id, name, kind, parent_id, deleted_at, updated_at",
    destinationTable: "channels",
    columns: ["id", "guild_id", "parent_id", "name", "type", "is_thread", "updated_at"],
    conflict: "(id) DO UPDATE SET guild_id=excluded.guild_id, parent_id=excluded.parent_id, name=excluded.name, type=excluded.type, is_thread=excluded.is_thread, updated_at=excluded.updated_at",
    map: (row) => [row.channel_id, row.guild_id, row.parent_id, row.name, Number(row.kind), Number(row.kind) === 11 || Number(row.kind) === 12, row.updated_at],
  });

  await copyBatches({
    label: "Discord messages",
    sourceTable: "discord_messages",
    key: "message_id",
    select: "guild_id, channel_id, message_id, thread_id, reply_to_message_id, author_user_id, content, normalized_payload, source_created_at, source_updated_at, deleted_at",
    destinationTable: "messages",
    columns: ["id", "guild_id", "channel_id", "thread_id", "author_id", "content", "normalized_content", "created_at", "edited_at", "deleted_at", "raw", "referenced_message_id"],
    conflict: "(id) DO UPDATE SET content=excluded.content, normalized_content=excluded.normalized_content, edited_at=excluded.edited_at, deleted_at=excluded.deleted_at, raw=excluded.raw, referenced_message_id=excluded.referenced_message_id, updated_at=now()",
    map: (row) => [row.message_id, row.guild_id, row.channel_id, row.thread_id, row.author_user_id, row.content, row.content, row.source_created_at, row.source_updated_at, row.deleted_at, row.normalized_payload, row.reply_to_message_id],
  });

  await copyBatches({
    label: "Discord attachments",
    sourceTable: "discord_attachments",
    key: "attachment_id",
    select: "attachment_id, message_id, url, filename, content_type, size_bytes",
    destinationTable: "attachments",
    columns: ["id", "message_id", "url", "filename", "content_type", "size_bytes"],
    conflict: "(id) DO UPDATE SET url=excluded.url, filename=excluded.filename, content_type=excluded.content_type, size_bytes=excluded.size_bytes",
    map: (row) => [row.attachment_id, row.message_id, row.url, row.filename, row.content_type, row.size_bytes],
  });

  await finalizeCrawlCursors();
}

async function finalizeCrawlCursors() {
  await destination.query(`
    INSERT INTO crawl_cursors(channel_id, guild_id, last_message_id, status, crawled_count)
    SELECT channel_id, guild_id, max(id), 'complete', count(*)
    FROM messages GROUP BY channel_id, guild_id
    ON CONFLICT (channel_id) DO UPDATE SET
      last_message_id=excluded.last_message_id, status='complete',
      crawled_count=excluded.crawled_count, updated_at=now()
  `);
}

async function copyPreferencesAndPrivacy() {
  const preferences = await source.query("SELECT user_id, timezone, updated_at FROM member_preferences ORDER BY user_id");
  await insertRows(destination, "user_preferences", ["user_id", "preference_key", "preference_value", "updated_at"],
    preferences.rows.map((row) => [row.user_id, "timezone", JSON.stringify(row.timezone), row.updated_at]),
    "(user_id, preference_key) DO UPDATE SET preference_value=excluded.preference_value, updated_at=excluded.updated_at");

  const deletions = await source.query("SELECT user_id, min(deleted_at) AS deleted_at FROM privacy_deleted_users GROUP BY user_id ORDER BY user_id");
  await insertRows(destination, "privacy_deletions", ["user_id", "requested_at"],
    deletions.rows.map((row) => [row.user_id, row.deleted_at]),
    "(user_id) DO UPDATE SET requested_at=least(privacy_deletions.requested_at, excluded.requested_at)");
}

async function copyWalletCustody() {
  const wallets = await source.query(`
    SELECT wallet_id::text, guild_id, owner_kind, owner_user_id, provider,
           provider_wallet_id, external_id, address, chain_id, status,
           error_message, starter_funded_at, created_at, updated_at,
           token_symbol, token_address, token_decimals
    FROM wallet_accounts ORDER BY wallet_id
  `);
  await insertRows(destination, "wallet_accounts",
    ["id", "guild_id", "owner_kind", "discord_user_id", "provider", "provider_wallet_id", "external_id", "address", "chain_id", "status", "error_message", "created_at", "updated_at"],
    wallets.rows.map((row) => [row.wallet_id, row.guild_id, row.owner_kind === "member" ? "user" : row.owner_kind, row.owner_user_id, row.provider, row.provider_wallet_id, row.external_id, row.address, row.chain_id, row.status, row.error_message, row.created_at, row.updated_at]),
    "(id) DO UPDATE SET provider_wallet_id=excluded.provider_wallet_id, external_id=excluded.external_id, address=excluded.address, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at");

  const bot = wallets.rows.find((row) => row.owner_kind === "bot");
  if (!bot) throw new Error("The source database has no treasury wallet.");
  for (const row of wallets.rows.filter((wallet) => wallet.owner_kind === "member" && wallet.starter_funded_at)) {
    const transferId = `imported-starter-${row.wallet_id}`;
    await destination.query(`
      INSERT INTO wallet_transfers(
        id, guild_id, requested_by_user_id, source_wallet_id, destination_wallet_id,
        destination_address, purpose, token, token_address, token_decimals,
        amount_atomic, idempotency_key, memo_hex, status, metadata,
        created_at, submitted_at, confirmed_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,'starter_grant',$7,$8,$9,1,$10,'0x','confirmed',
        '{"importedCustodyMarker":true}'::jsonb,$11,$11,$11,$11)
      ON CONFLICT (id) DO NOTHING
    `, [transferId, row.guild_id, row.owner_user_id, bot.wallet_id, row.wallet_id, row.address,
      row.token_symbol, String(row.token_address).toLowerCase(), row.token_decimals,
      `imported-starter:${row.wallet_id}:${String(row.token_address).toLowerCase()}`, row.starter_funded_at]);
    await destination.query(`
      INSERT INTO wallet_initial_grants(wallet_id, token_address, transfer_id)
      VALUES ($1, lower($2), $3) ON CONFLICT (wallet_id, token_address) DO NOTHING
    `, [row.wallet_id, row.token_address, transferId]);
    await destination.query("UPDATE wallet_accounts SET initial_grant_transfer_id=$2 WHERE id=$1", [row.wallet_id, transferId]);
  }
  process.stdout.write(`Imported ${wallets.rowCount ?? wallets.rows.length} managed wallet identities without moving funds.\n`);
}

async function copyBatches(spec: CopySpec) {
  let cursor = "";
  let copied = 0;
  for (;;) {
    const result = await source.query(
      `SELECT ${spec.select} FROM ${spec.sourceTable} WHERE ${spec.key} > $1 ORDER BY ${spec.key} LIMIT $2`,
      [cursor, BATCH_SIZE],
    );
    if (result.rows.length === 0) break;
    await insertRows(destination, spec.destinationTable, spec.columns, result.rows.map(spec.map), spec.conflict);
    cursor = String(result.rows.at(-1)?.[spec.key]);
    copied += result.rows.length;
    if (copied % 25_000 === 0) process.stdout.write(`${spec.label}: ${copied} rows.\n`);
  }
  process.stdout.write(`${spec.label}: ${copied} rows imported.\n`);
}

async function insertRows(pool: Pool, table: string, columns: string[], rows: unknown[][], conflict: string) {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    if (row.length !== columns.length) throw new Error(`Column mismatch while importing ${table}.`);
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(",")})`;
  });
  await pool.query(`INSERT INTO ${table}(${columns.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT ${conflict}`, values);
}

async function assertDestinationReady() {
  const result = await destination.query("SELECT to_regclass('public.schema_migrations') AS migrations, to_regclass('public.wallet_accounts') AS wallets");
  if (!result.rows[0]?.migrations || !result.rows[0]?.wallets) {
    throw new Error("Run discord-ai-agent migrations on the destination database before importing.");
  }
}

function guildIdsQuery() {
  return "SELECT guild_id FROM discord_channels UNION SELECT guild_id FROM discord_members UNION SELECT guild_id FROM wallet_accounts";
}

function requiredUrl(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function sameDatabase(left: string, right: string) {
  const a = new URL(left);
  const b = new URL(right);
  return a.hostname === b.hostname && (a.port || "5432") === (b.port || "5432") && a.pathname === b.pathname;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all([source.end(), destination.end()]);
});
