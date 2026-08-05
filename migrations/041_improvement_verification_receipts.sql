CREATE TABLE improvement_verification_proofs (
  proof_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES improvement_contracts(contract_id) ON DELETE CASCADE,
  contract_version integer NOT NULL CHECK (contract_version > 0),
  revision text NOT NULL,
  deployment_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('private_eval', 'revision_quality')),
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
  reference_type text NOT NULL,
  reference_id text NOT NULL,
  run_key text NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, contract_id, deployment_id, reference_id, run_key)
);

CREATE INDEX improvement_verification_proofs_contract_idx
  ON improvement_verification_proofs(contract_id, revision, deployment_id, created_at DESC);

CREATE TABLE improvement_verification_receipts (
  receipt_id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES improvement_cases(case_id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES improvement_contracts(contract_id) ON DELETE CASCADE,
  contract_version integer NOT NULL CHECK (contract_version > 0),
  revision text NOT NULL,
  deployment_id text NOT NULL,
  execution_id text REFERENCES agent_runtime_executions(execution_id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
  checks jsonb NOT NULL,
  application_key text NOT NULL UNIQUE,
  evidence_id text REFERENCES improvement_evidence(evidence_id) ON DELETE SET NULL,
  applied boolean NOT NULL DEFAULT false,
  actor_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX improvement_verification_receipts_case_idx
  ON improvement_verification_receipts(case_id, created_at DESC);
