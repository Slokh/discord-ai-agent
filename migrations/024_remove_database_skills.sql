-- Database-backed prompt skills were removed from the model surface. Clear
-- existing rows so stale private instructions cannot re-enter prompt context
-- through an older application revision or an operational replay.
DELETE FROM skills
WHERE source = 'database';
