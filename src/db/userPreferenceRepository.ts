import type { DbPool } from "./pool.js";

export type UserPreference = {
  userId: string;
  key: string;
  value: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export async function getUserPreference(
  pool: DbPool,
  userId: string,
  key: string,
): Promise<UserPreference | undefined> {
  const result = await pool.query(
    `
      SELECT user_id, preference_key, preference_value, created_at, updated_at
      FROM user_preferences
      WHERE user_id = $1 AND preference_key = $2
    `,
    [userId, key],
  );
  return result.rows[0] ? rowToUserPreference(result.rows[0]) : undefined;
}

export async function setUserPreference(
  pool: DbPool,
  input: { userId: string; key: string; value: unknown },
): Promise<UserPreference> {
  const serializedValue = JSON.stringify(input.value);
  if (serializedValue === undefined) throw new TypeError("User preference values must be JSON-serializable.");
  const result = await pool.query(
    `
      INSERT INTO user_preferences(user_id, preference_key, preference_value, updated_at)
      VALUES ($1, $2, $3::jsonb, now())
      ON CONFLICT(user_id, preference_key) DO UPDATE SET
        preference_value = EXCLUDED.preference_value,
        updated_at = now()
      RETURNING user_id, preference_key, preference_value, created_at, updated_at
    `,
    [input.userId, input.key, serializedValue],
  );
  return rowToUserPreference(result.rows[0]);
}

export async function clearUserPreference(
  pool: DbPool,
  userId: string,
  key: string,
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM user_preferences WHERE user_id = $1 AND preference_key = $2",
    [userId, key],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function clearUserPreferences(
  pool: DbPool,
  userId: string,
): Promise<number> {
  const result = await pool.query(
    "DELETE FROM user_preferences WHERE user_id = $1",
    [userId],
  );
  return result.rowCount ?? 0;
}

function rowToUserPreference(row: Record<string, unknown>): UserPreference {
  return {
    userId: String(row.user_id),
    key: String(row.preference_key),
    value: row.preference_value,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}
