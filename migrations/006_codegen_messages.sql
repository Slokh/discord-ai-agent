CREATE TABLE IF NOT EXISTS codegen_messages (
  message_id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES codegen_sessions(session_id) ON DELETE CASCADE,
  client_message_id text,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT codegen_messages_role_supported
    CHECK (role IN ('system', 'user', 'assistant', 'tool'))
);

CREATE UNIQUE INDEX IF NOT EXISTS codegen_messages_session_client_message_idx
  ON codegen_messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS codegen_messages_session_created_idx
  ON codegen_messages(session_id, created_at ASC, message_id ASC);
