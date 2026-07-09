import type { DbPool } from "./pool.js";
import { databaseSkillFromRow, rowToServerOverlay, rowToDurableWorkflow } from "./shared.js";
import type { DatabaseSkill, ServerOverlay, DurableWorkflowStatus, DurableWorkflow } from "./shared.js";

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

export async function upsertDurableWorkflow(pool: DbPool, input: {
    id: string;
    guildId?: string | null;
    name: string;
    kind: string;
    status?: DurableWorkflowStatus;
    schedule?: string | null;
    state?: Record<string, unknown>;
    nextRunAt?: Date | null;
  }): Promise<DurableWorkflow> {
    const result = await pool.query(
      `
        INSERT INTO durable_workflows(id, guild_id, name, kind, status, schedule, state, next_run_at, updated_at)
        VALUES ($1, $2, $3, $4, coalesce($5, 'paused'), $6, $7, $8, now())
        ON CONFLICT(id) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          name = EXCLUDED.name,
          kind = EXCLUDED.kind,
          status = EXCLUDED.status,
          schedule = EXCLUDED.schedule,
          state = durable_workflows.state || EXCLUDED.state,
          next_run_at = EXCLUDED.next_run_at,
          updated_at = now()
        RETURNING id, guild_id, name, kind, status, schedule, state, last_started_at, last_completed_at, next_run_at, locked_at, created_at, updated_at
      `,
      [
        input.id,
        input.guildId ?? null,
        input.name,
        input.kind,
        input.status ?? null,
        input.schedule ?? null,
        JSON.stringify(input.state ?? {}),
        input.nextRunAt ?? null
      ]
    );
    return rowToDurableWorkflow(result.rows[0]);
  }

export async function listDueDurableWorkflows(pool: DbPool, input: { limit: number; now?: Date }): Promise<DurableWorkflow[]> {
    const result = await pool.query(
      `
        SELECT id, guild_id, name, kind, status, schedule, state, last_started_at, last_completed_at, next_run_at, locked_at, created_at, updated_at
        FROM durable_workflows
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= $1
        ORDER BY next_run_at ASC, id ASC
        LIMIT $2
      `,
      [input.now ?? new Date(), Math.max(1, Math.min(100, Math.trunc(input.limit)))]
    );
    return result.rows.map(rowToDurableWorkflow);
  }

export async function markDurableWorkflowRunStarted(pool: DbPool, input: { id: string; lockedAt?: Date }): Promise<boolean> {
    const result = await pool.query(
      `
        UPDATE durable_workflows
        SET status = 'running',
            locked_at = $2,
            last_started_at = $2,
            updated_at = now()
        WHERE id = $1
          AND status = 'active'
        RETURNING id
      `,
      [input.id, input.lockedAt ?? new Date()]
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

export async function markDurableWorkflowRunFinished(pool: DbPool, input: {
    id: string;
    status?: DurableWorkflowStatus;
    state?: Record<string, unknown>;
    nextRunAt?: Date | null;
  }): Promise<boolean> {
    const result = await pool.query(
      `
        UPDATE durable_workflows
        SET status = $2,
            state = state || $3,
            last_completed_at = now(),
            next_run_at = $4,
            locked_at = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING id
      `,
      [input.id, input.status ?? "active", JSON.stringify(input.state ?? {}), input.nextRunAt ?? null]
    );
    return Boolean(result.rowCount && result.rowCount > 0);
  }

export async function health(pool: DbPool, ) {
    const [messages, embeddings, tools, estimatedCost, sessions] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM messages WHERE deleted_at IS NULL"),
      pool.query("SELECT count(*)::int AS count FROM message_embeddings"),
      pool.query("SELECT count(*)::int AS count FROM tool_audit_logs"),
      pool.query("SELECT coalesce(sum(estimated_cost_usd), 0)::float AS cost FROM tool_audit_logs"),
      pool.query("SELECT count(*)::int AS count FROM conversation_sessions")
    ]);
    return {
      messages: Number(messages.rows[0]?.count ?? 0),
      embeddings: Number(embeddings.rows[0]?.count ?? 0),
      toolCalls: Number(tools.rows[0]?.count ?? 0),
      conversationSessions: Number(sessions.rows[0]?.count ?? 0),
      estimatedCostUsd: Number(estimatedCost.rows[0]?.cost ?? 0)
    };
  }
