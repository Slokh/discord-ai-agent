import type { DiscordAiAgentRepository } from "../db/repositories.js";

export async function renderMetrics(repo: DiscordAiAgentRepository) {
  const [health, taskMetrics] = await Promise.all([
    repo.health(),
    repo.getAgentTaskMetrics(),
  ]);
  const runtimeTelemetry = health.runtimeTelemetry ?? [];
  const lines = [
    "# HELP discord_ai_agent_messages_indexed Indexed non-deleted Discord messages.",
    "# TYPE discord_ai_agent_messages_indexed gauge",
    `discord_ai_agent_messages_indexed ${health.messages}`,
    "# HELP discord_ai_agent_embeddings_stored Stored message embeddings.",
    "# TYPE discord_ai_agent_embeddings_stored gauge",
    `discord_ai_agent_embeddings_stored ${health.embeddings}`,
    "# HELP discord_ai_agent_tool_calls_logged Logged tool calls.",
    "# TYPE discord_ai_agent_tool_calls_logged counter",
    `discord_ai_agent_tool_calls_logged ${health.toolCalls}`,
    "# HELP discord_ai_agent_conversation_sessions Stored conversation sessions.",
    "# TYPE discord_ai_agent_conversation_sessions gauge",
    `discord_ai_agent_conversation_sessions ${health.conversationSessions}`,
    "# HELP discord_ai_agent_estimated_cost_usd_total Estimated audited model and tool cost in US dollars.",
    "# TYPE discord_ai_agent_estimated_cost_usd_total counter",
    `discord_ai_agent_estimated_cost_usd_total ${health.estimatedCostUsd}`,
    "# HELP discord_ai_agent_runtime_events_total Runtime events in the last 24 hours by category.",
    "# TYPE discord_ai_agent_runtime_events_total gauge",
    ...runtimeTelemetry.map(
      (row) =>
        `discord_ai_agent_runtime_events_total{category=${quoteMetricLabel(row.category)}} ${row.calls}`,
    ),
    "# HELP discord_ai_agent_runtime_errors_total Failed runtime events in the last 24 hours by category.",
    "# TYPE discord_ai_agent_runtime_errors_total gauge",
    ...runtimeTelemetry.map(
      (row) =>
        `discord_ai_agent_runtime_errors_total{category=${quoteMetricLabel(row.category)}} ${row.errors}`,
    ),
    "# HELP discord_ai_agent_runtime_duration_ms Runtime event latency in milliseconds over the last 24 hours.",
    "# TYPE discord_ai_agent_runtime_duration_ms histogram",
    ...runtimeTelemetry.flatMap((row) => [
      ...row.buckets.map(
        (bucket) =>
          `discord_ai_agent_runtime_duration_ms_bucket{category=${quoteMetricLabel(row.category)},le=${quoteMetricLabel(String(bucket.le))}} ${bucket.count}`,
      ),
      `discord_ai_agent_runtime_duration_ms_bucket{category=${quoteMetricLabel(row.category)},le="+Inf"} ${row.durationCount}`,
      `discord_ai_agent_runtime_duration_ms_sum{category=${quoteMetricLabel(row.category)}} ${row.durationSumMs}`,
      `discord_ai_agent_runtime_duration_ms_count{category=${quoteMetricLabel(row.category)}} ${row.durationCount}`,
    ]),
    "# HELP discord_ai_agent_runtime_cost_usd Estimated runtime model/tool cost in the last 24 hours.",
    "# TYPE discord_ai_agent_runtime_cost_usd gauge",
    ...runtimeTelemetry.map(
      (row) =>
        `discord_ai_agent_runtime_cost_usd{category=${quoteMetricLabel(row.category)}} ${row.estimatedCostUsd}`,
    ),
    "# HELP discord_ai_agent_runtime_tokens Runtime model tokens in the last 24 hours by cache disposition.",
    "# TYPE discord_ai_agent_runtime_tokens gauge",
    ...runtimeTelemetry.flatMap((row) => [
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="input"} ${row.inputTokens}`,
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="cached_input"} ${row.cachedInputTokens}`,
      `discord_ai_agent_runtime_tokens{category=${quoteMetricLabel(row.category)},type="output"} ${row.outputTokens}`,
    ]),
    "# HELP discord_ai_agent_agent_tasks_total Agent tasks by status.",
    "# TYPE discord_ai_agent_agent_tasks_total gauge",
    ...taskMetrics.tasksByStatus.map(
      (row) =>
        `discord_ai_agent_agent_tasks_total{status=${quoteMetricLabel(row.status)}} ${row.count}`,
    ),
    "# HELP discord_ai_agent_agent_task_backlog_total Active queued/running agent tasks by backend and status.",
    "# TYPE discord_ai_agent_agent_task_backlog_total gauge",
    ...taskMetrics.agentTaskBacklog.map(
      (row) =>
        `discord_ai_agent_agent_task_backlog_total{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(row.status)}} ${row.count}`,
    ),
    "# HELP discord_ai_agent_agent_task_backlog_oldest_age_seconds Oldest active queued/running agent task age by backend and status.",
    "# TYPE discord_ai_agent_agent_task_backlog_oldest_age_seconds gauge",
    ...taskMetrics.agentTaskBacklog.map(
      (row) =>
        `discord_ai_agent_agent_task_backlog_oldest_age_seconds{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(
          row.status,
        )}} ${row.oldestAgeSeconds}`,
    ),
    "# HELP discord_ai_agent_sandbox_runs_total Sandbox runs by status.",
    "# TYPE discord_ai_agent_sandbox_runs_total gauge",
    ...taskMetrics.sandboxRunsByStatus.map(
      (row) =>
        `discord_ai_agent_sandbox_runs_total{status=${quoteMetricLabel(row.status)}} ${row.count}`,
    ),
    "# HELP discord_ai_agent_agent_runtime_sandbox_leases_total Agent runtime sandbox leases by backend and status.",
    "# TYPE discord_ai_agent_agent_runtime_sandbox_leases_total gauge",
    ...taskMetrics.sandboxLeases.map(
      (row) =>
        `discord_ai_agent_agent_runtime_sandbox_leases_total{backend=${quoteMetricLabel(row.backend)},status=${quoteMetricLabel(row.status)}} ${row.count}`,
    ),
    "# HELP discord_ai_agent_task_phase_duration_avg_ms Average code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_task_phase_duration_avg_ms gauge",
    ...taskMetrics.taskPhaseDurations.map(
      (row) =>
        `discord_ai_agent_task_phase_duration_avg_ms{phase=${quoteMetricLabel(row.phase)}} ${row.avgMs}`,
    ),
    "# HELP discord_ai_agent_task_phase_duration_max_ms Maximum code-update phase duration in milliseconds.",
    "# TYPE discord_ai_agent_task_phase_duration_max_ms gauge",
    ...taskMetrics.taskPhaseDurations.map(
      (row) =>
        `discord_ai_agent_task_phase_duration_max_ms{phase=${quoteMetricLabel(row.phase)}} ${row.maxMs}`,
    ),
    "# HELP discord_ai_agent_sandbox_cache_events_total Sandbox cache hit/miss events by cache type.",
    "# TYPE discord_ai_agent_sandbox_cache_events_total counter",
    ...taskMetrics.sandboxCacheEvents.map(
      (row) =>
        `discord_ai_agent_sandbox_cache_events_total{cache_type=${quoteMetricLabel(row.cacheType)},cache_status=${quoteMetricLabel(
          row.cacheStatus,
        )}} ${row.count}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function quoteMetricLabel(value: string) {
  return JSON.stringify(value);
}
