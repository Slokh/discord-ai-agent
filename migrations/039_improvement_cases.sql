-- One canonical improvement lifecycle replaces markers, bug reports, run
-- feedback, and Frog friction. Existing report data is intentionally discarded.
DROP TABLE IF EXISTS discord_bug_reports;
DROP TABLE IF EXISTS discord_bug_markers;
DROP TABLE IF EXISTS agent_run_feedback;
DROP TABLE IF EXISTS frog_entries;

CREATE TABLE improvement_cases (
  case_id text PRIMARY KEY,
  guild_id text REFERENCES guilds(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('guild', 'repository', 'deployment', 'global')),
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'publication_safe')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'open' CHECK (
    status IN ('open', 'needs_evidence', 'actionable', 'in_progress', 'verifying', 'resolved', 'dismissed')
  ),
  classification text NOT NULL DEFAULT 'unknown' CHECK (
    classification IN ('unknown', 'defect', 'product_gap', 'data_quality', 'developer_friction', 'external_incident', 'expected_behavior')
  ),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  owning_domain text,
  fingerprint text,
  merged_into_case_id text REFERENCES improvement_cases(case_id) ON DELETE SET NULL,
  resolution text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_cases_inbox_idx
  ON improvement_cases(status, last_seen_at DESC)
  WHERE merged_into_case_id IS NULL;
CREATE INDEX improvement_cases_fingerprint_idx
  ON improvement_cases(guild_id, privacy, fingerprint, last_seen_at DESC)
  WHERE fingerprint IS NOT NULL AND merged_into_case_id IS NULL;

CREATE TABLE improvement_signals (
  signal_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN (
    'member_report', 'agent_report', 'operator_report', 'developer_report',
    'runtime_detection', 'deployment_detection', 'ci_detection', 'eval_detection'
  )),
  source_key text NOT NULL UNIQUE,
  reporter_kind text NOT NULL CHECK (reporter_kind IN ('member', 'agent', 'operator', 'developer', 'automation')),
  reporter_id text,
  guild_id text,
  channel_id text,
  message_id text,
  execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  task_id text REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  app_revision text,
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'publication_safe')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  details text,
  severity_hint text CHECK (severity_hint IS NULL OR severity_hint IN ('low', 'medium', 'high', 'critical')),
  classification_hint text CHECK (classification_hint IS NULL OR classification_hint IN (
    'unknown', 'defect', 'product_gap', 'data_quality', 'developer_friction', 'external_incident', 'expected_behavior'
  )),
  owning_domain_hint text,
  fingerprint text,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}',
  observed_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_signals_case_idx ON improvement_signals(case_id, observed_at DESC);
CREATE INDEX improvement_signals_reporter_idx
  ON improvement_signals(guild_id, reporter_id, observed_at DESC)
  WHERE active = true;

CREATE TABLE improvement_evidence (
  evidence_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  signal_id text REFERENCES improvement_signals(signal_id) ON DELETE SET NULL,
  kind text NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('supports', 'contradicts', 'inconclusive')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  reference_type text,
  reference_id text,
  collected_by_execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  privacy text NOT NULL DEFAULT 'private' CHECK (privacy IN ('private', 'publication_safe')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_evidence_case_idx ON improvement_evidence(case_id, created_at DESC);

CREATE TABLE improvement_contracts (
  contract_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  expected_behavior text NOT NULL CHECK (length(expected_behavior) BETWEEN 1 AND 4000),
  checks jsonb NOT NULL,
  executable boolean NOT NULL DEFAULT false,
  source_revision text,
  created_by text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(case_id, version)
);

CREATE UNIQUE INDEX improvement_contracts_active_idx
  ON improvement_contracts(case_id)
  WHERE active = true;

CREATE TABLE improvement_case_events (
  event_id bigserial PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  signal_id text REFERENCES improvement_signals(signal_id) ON DELETE SET NULL,
  event_name text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('member', 'agent', 'operator', 'developer', 'automation', 'system')),
  actor_id text,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_case_events_stream_idx ON improvement_case_events(created_at DESC, event_id DESC);
CREATE INDEX improvement_case_events_case_idx ON improvement_case_events(case_id, event_id);

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS improvement_case_id text REFERENCES improvement_cases(case_id) ON DELETE SET NULL;
CREATE INDEX agent_tasks_improvement_case_idx ON agent_tasks(improvement_case_id, updated_at DESC)
  WHERE improvement_case_id IS NOT NULL;
