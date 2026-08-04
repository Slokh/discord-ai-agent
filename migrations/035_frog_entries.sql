CREATE TABLE frog_entries (
  namespace text NOT NULL,
  id text NOT NULL,
  dedupe_key text NOT NULL,
  contents text NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, id),
  UNIQUE (namespace, dedupe_key)
);
