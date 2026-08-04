ALTER TABLE deployment_verifications
  ADD COLUMN deployment_id text;

UPDATE deployment_verifications
SET deployment_id = revision
WHERE deployment_id IS NULL;

ALTER TABLE deployment_verifications
  ALTER COLUMN deployment_id SET NOT NULL,
  DROP CONSTRAINT deployment_verifications_pkey,
  ADD PRIMARY KEY (revision, deployment_id);
