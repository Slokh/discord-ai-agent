import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config/env.js";
import { startProductionDatabaseTunnel } from "../src/console/productionDatabaseTunnel.js";
import { createPool } from "../src/db/pool.js";

const NAMESPACE = "discord-ai-agent";
const SECRET = "discord-ai-agent-env";
const ROLE = "discord_ai_agent_console_readonly";

export function requireConsoleDatabaseProvisionConfirmation(argv: string[]) {
  const unknown = argv.filter((argument) => argument !== "--confirm-production");
  if (unknown.length) throw new Error(`Unknown console database provision argument: ${unknown.join(", ")}`);
  if (!argv.includes("--confirm-production")) {
    throw new Error("Provisioning the production Console database role requires --confirm-production.");
  }
}

async function main() {
  requireConsoleDatabaseProvisionConfirmation(process.argv.slice(2));
  const tunnel = await startProductionDatabaseTunnel({
    credentialVariable: "DATABASE_URL",
    component: "api",
    mode: "administrative",
  });
  const config = loadConfig(["node", "provision-console-database", "console"]);
  config.databaseUrl = tunnel.databaseUrl;
  const pool = createPool(config);
  try {
    const password = randomBytes(36).toString("base64url");
    const role = quoteIdentifier(ROLE);
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
    if (exists.rowCount) {
      await pool.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
    } else {
      await pool.query(`CREATE ROLE ${role} WITH LOGIN PASSWORD ${quoteLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    }
    const database = await pool.query("SELECT current_database() AS name");
    const databaseName = String(database.rows[0]?.name ?? "");
    if (!databaseName) throw new Error("Could not resolve the production database name.");
    await pool.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(databaseName)} TO ${role}`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${role}`);
    await pool.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
    await pool.query(`ALTER ROLE ${role} SET statement_timeout = '30s'`);

    const privileges = await pool.query(
      `SELECT
         has_schema_privilege($1,'public','USAGE') AS schema_usage,
         has_schema_privilege($1,'public','CREATE') AS schema_create,
         coalesce(bool_and(has_table_privilege($1,format('%I.%I',schemaname,tablename),'SELECT')),true) AS reads_all,
         coalesce(bool_or(
           has_table_privilege($1,format('%I.%I',schemaname,tablename),'INSERT') OR
           has_table_privilege($1,format('%I.%I',schemaname,tablename),'UPDATE') OR
           has_table_privilege($1,format('%I.%I',schemaname,tablename),'DELETE') OR
           has_table_privilege($1,format('%I.%I',schemaname,tablename),'TRUNCATE')
         ),false) AS writes_any,
         role_row.rolsuper,role_row.rolcreatedb,role_row.rolcreaterole,role_row.rolreplication,role_row.rolinherit
       FROM pg_tables
       CROSS JOIN pg_roles role_row
       WHERE schemaname = 'public' AND role_row.rolname = $1
       GROUP BY role_row.rolsuper,role_row.rolcreatedb,role_row.rolcreaterole,role_row.rolreplication,role_row.rolinherit`,
      [ROLE],
    );
    const privilege = privileges.rows[0];
    if (!privilege?.schema_usage || privilege.schema_create || !privilege.reads_all || privilege.writes_any ||
      privilege.rolsuper || privilege.rolcreatedb || privilege.rolcreaterole || privilege.rolreplication || privilege.rolinherit) {
      throw new Error("The provisioned Console role did not satisfy the required read-only privilege boundary.");
    }

    const readonlyUrl = consoleDatabaseUrl(tunnel.productionDatabaseUrl, password);
    patchSecret(readonlyUrl);
    process.stdout.write("Provisioned the production Console read-only database role and Kubernetes credential.\n");
  } finally {
    await pool.end().catch(() => undefined);
    await tunnel.close().catch(() => undefined);
  }
}

export function consoleDatabaseUrl(source: string, password: string) {
  const url = new URL(source);
  url.username = ROLE;
  url.password = password;
  url.searchParams.set("options", "-c default_transaction_read_only=on -c statement_timeout=30000");
  return url.toString();
}

function patchSecret(databaseUrl: string) {
  const patch = JSON.stringify({ data: {
    CONSOLE_DATABASE_URL: Buffer.from(databaseUrl, "utf8").toString("base64"),
  } });
  const result = spawnSync("kubectl", [
    "--namespace", NAMESPACE, "patch", "secret", SECRET,
    "--type=merge", "--patch-file=/dev/stdin",
  ], { input: patch, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Failed to store CONSOLE_DATABASE_URL: ${result.stderr.trim() || `exit ${String(result.status)}`}`);
  }
}

function quoteIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
