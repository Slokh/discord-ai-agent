CREATE TABLE IF NOT EXISTS skills (
  name text PRIMARY KEY,
  file_path text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'repo',
  content text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  last_pr_url text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_changes (
  id bigserial PRIMARY KEY,
  skill_name text NOT NULL,
  file_path text NOT NULL,
  requester_id text,
  request text,
  branch_name text,
  pr_url text,
  dry_run boolean NOT NULL DEFAULT false,
  merged boolean NOT NULL DEFAULT false,
  policy_reasons jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_changes_skill_created_idx ON skill_changes(skill_name, created_at DESC);
