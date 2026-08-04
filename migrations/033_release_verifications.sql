CREATE TABLE IF NOT EXISTS deployment_verifications (
  revision text PRIMARY KEY,
  verified_at timestamptz NOT NULL DEFAULT now()
);
