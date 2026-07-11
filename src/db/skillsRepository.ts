import type { DbPool } from "./pool.js";
import { databaseSkillFromRow, rowToServerOverlay } from "./shared.js";
import type { DatabaseSkill, ServerOverlay } from "./shared.js";

export async function recordSkillChange(pool: DbPool, input: {
    skillName: string;
    filePath: string;
    requesterId?: string | null;
    request?: string | null;
    branchName?: string | null;
    prUrl?: string | null;
    content?: string | null;
    source?: string;
    merged?: boolean;
    policyReasons?: string[];
  }) {
    await pool.query(
      `
        INSERT INTO skill_changes(
          skill_name, file_path, requester_id, request, branch_name,
          pr_url, merged, policy_reasons
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.skillName,
        input.filePath,
        input.requesterId ?? null,
        input.request ?? null,
        input.branchName ?? null,
        input.prUrl ?? null,
        input.merged ?? false,
        JSON.stringify(input.policyReasons ?? [])
      ]
    );

    if (!input.policyReasons?.length) {
      await pool.query(
        `
          INSERT INTO skills(name, file_path, source, content, enabled, version, last_pr_url, updated_at)
          VALUES ($1, $2, $3, $4, true, 1, $5, now())
          ON CONFLICT(name) DO UPDATE SET
            file_path = EXCLUDED.file_path,
            source = EXCLUDED.source,
            content = coalesce(nullif(EXCLUDED.content, ''), skills.content),
            enabled = true,
            version = skills.version + 1,
            last_pr_url = EXCLUDED.last_pr_url,
            updated_at = now()
        `,
        [input.skillName, input.filePath, input.source ?? "repo", input.content ?? "", input.prUrl ?? null]
      );
    }
  }

export async function listEnabledDatabaseSkills(pool: DbPool, ): Promise<Array<{ name: string; content: string; version: number }>> {
    const result = await pool.query(
      `
        SELECT name, content, version
        FROM skills
        WHERE source = 'database'
          AND enabled = true
          AND content <> ''
        ORDER BY name
      `
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      content: String(row.content),
      version: Number(row.version)
    }));
  }

export async function listDatabaseSkills(pool: DbPool, input: { includeDisabled?: boolean } = {}): Promise<DatabaseSkill[]> {
    const result = await pool.query(
      `
        SELECT name, file_path, source, content, enabled, version, last_pr_url,
               created_by, updated_by, created_at, updated_at
        FROM skills
        WHERE source = 'database'
          AND ($1::boolean = true OR enabled = true)
        ORDER BY name
      `,
      [input.includeDisabled ?? false]
    );
    return result.rows.map(databaseSkillFromRow);
  }

export async function upsertDatabaseSkill(pool: DbPool, input: { name: string; content: string; requesterId?: string | null; request?: string | null }): Promise<DatabaseSkill> {
    const filePath = `database:${input.name}.md`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `
          INSERT INTO skills(name, file_path, source, content, enabled, version, created_by, updated_by, updated_at)
          VALUES ($1, $2, 'database', $3, true, 1, $4, $4, now())
          ON CONFLICT(name) DO UPDATE SET
            file_path = EXCLUDED.file_path,
            source = 'database',
            content = EXCLUDED.content,
            enabled = true,
            version = skills.version + 1,
            created_by = coalesce(skills.created_by, EXCLUDED.created_by),
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING name, file_path, source, content, enabled, version, last_pr_url,
                    created_by, updated_by, created_at, updated_at
        `,
        [input.name, filePath, input.content, input.requesterId ?? null]
      );
      await client.query(
        `
          INSERT INTO skill_changes(
            skill_name, file_path, requester_id, request, branch_name,
            pr_url, merged, policy_reasons
          )
          VALUES ($1, $2, $3, $4, null, null, true, '[]'::jsonb)
        `,
        [input.name, filePath, input.requesterId ?? null, input.request ?? null]
      );
      await client.query("COMMIT");
      return databaseSkillFromRow(result.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

export async function setDatabaseSkillEnabled(pool: DbPool, input: { name: string; enabled: boolean; requesterId?: string | null }): Promise<DatabaseSkill | null> {
    const result = await pool.query(
      `
        UPDATE skills
        SET enabled = $2,
            updated_by = $3,
            updated_at = now()
        WHERE name = $1
          AND source = 'database'
        RETURNING name, file_path, source, content, enabled, version, last_pr_url,
                  created_by, updated_by, created_at, updated_at
      `,
      [input.name, input.enabled, input.requesterId ?? null]
    );
    return result.rows[0] ? databaseSkillFromRow(result.rows[0]) : null;
  }

export async function deleteDatabaseSkill(pool: DbPool, name: string): Promise<boolean> {
    const result = await pool.query("DELETE FROM skills WHERE name = $1 AND source = 'database'", [name]);
    return (result.rowCount ?? 0) > 0;
  }

export async function getServerOverlay(pool: DbPool, guildId: string): Promise<ServerOverlay | undefined> {
    const result = await pool.query(
      `
        SELECT guild_id, enabled, system_prompt, tool_policy, metadata, created_by, updated_by, created_at, updated_at
        FROM server_overlays
        WHERE guild_id = $1
      `,
      [guildId]
    );
    const row = result.rows[0];
    return row ? rowToServerOverlay(row) : undefined;
  }

export async function upsertServerOverlay(pool: DbPool, input: {
    guildId: string;
    enabled?: boolean;
    systemPrompt?: string;
    toolPolicy?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    updatedBy?: string | null;
  }): Promise<ServerOverlay> {
    const result = await pool.query(
      `
        INSERT INTO server_overlays(guild_id, enabled, system_prompt, tool_policy, metadata, created_by, updated_by, updated_at)
        VALUES ($1, coalesce($2, true), coalesce($3, ''), $4, $5, $6, $6, now())
        ON CONFLICT(guild_id) DO UPDATE SET
          enabled = CASE WHEN $2::boolean IS NULL THEN server_overlays.enabled ELSE EXCLUDED.enabled END,
          system_prompt = coalesce(nullif(EXCLUDED.system_prompt, ''), server_overlays.system_prompt),
          tool_policy = server_overlays.tool_policy || EXCLUDED.tool_policy,
          metadata = server_overlays.metadata || EXCLUDED.metadata,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        RETURNING guild_id, enabled, system_prompt, tool_policy, metadata, created_by, updated_by, created_at, updated_at
      `,
      [
        input.guildId,
        input.enabled ?? null,
        input.systemPrompt ?? "",
        JSON.stringify(input.toolPolicy ?? {}),
        JSON.stringify(input.metadata ?? {}),
        input.updatedBy ?? null
      ]
    );
    return rowToServerOverlay(result.rows[0]);
  }

export async function health(pool: DbPool, ) {
    const [messages, embeddings, tools, estimatedCost, sessions, runtimeTelemetry] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM messages WHERE deleted_at IS NULL"),
      pool.query("SELECT count(*)::int AS count FROM message_embeddings"),
      pool.query("SELECT count(*)::int AS count FROM tool_audit_logs"),
      pool.query("SELECT coalesce(sum(estimated_cost_usd), 0)::float AS cost FROM tool_audit_logs"),
      pool.query("SELECT count(*)::int AS count FROM conversation_sessions"),
      pool.query(`
        SELECT category,
          count(*)::int AS calls,
          count(*) FILTER (WHERE phase = 'failed' OR event_name LIKE '%.failed')::int AS errors,
          coalesce(sum(duration_ms), 0)::float AS duration_sum_ms,
          count(duration_ms)::int AS duration_count,
          count(*) FILTER (WHERE duration_ms <= 100)::int AS le_100,
          count(*) FILTER (WHERE duration_ms <= 500)::int AS le_500,
          count(*) FILTER (WHERE duration_ms <= 1000)::int AS le_1000,
          count(*) FILTER (WHERE duration_ms <= 5000)::int AS le_5000,
          count(*) FILTER (WHERE duration_ms <= 30000)::int AS le_30000,
          coalesce(sum(estimated_cost_usd), 0)::float AS cost,
          coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
          coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
          coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens
        FROM agent_runtime_metric_projection
        WHERE created_at >= now() - interval '24 hours'
        GROUP BY category
        ORDER BY category
      `)
    ]);
    return {
      messages: Number(messages.rows[0]?.count ?? 0),
      embeddings: Number(embeddings.rows[0]?.count ?? 0),
      toolCalls: Number(tools.rows[0]?.count ?? 0),
      conversationSessions: Number(sessions.rows[0]?.count ?? 0),
      estimatedCostUsd: Number(estimatedCost.rows[0]?.cost ?? 0),
      runtimeTelemetry: runtimeTelemetry.rows.map((row) => ({
        category: String(row.category ?? "system"),
        calls: Number(row.calls ?? 0),
        errors: Number(row.errors ?? 0),
        durationSumMs: Number(row.duration_sum_ms ?? 0),
        durationCount: Number(row.duration_count ?? 0),
        buckets: [100, 500, 1000, 5000, 30000].map((le) => ({ le, count: Number(row[`le_${le}`] ?? 0) })),
        estimatedCostUsd: Number(row.cost ?? 0),
        inputTokens: Number(row.input_tokens ?? 0),
        outputTokens: Number(row.output_tokens ?? 0),
        cachedInputTokens: Number(row.cached_input_tokens ?? 0),
      }))
    };
  }
