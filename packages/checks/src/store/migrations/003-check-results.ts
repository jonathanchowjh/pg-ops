/**
 * Migration 003 — the hygiene cache.
 *
 * Stores what the last pass of each hygiene check found, so the
 * triage page can report a finding without running the check.
 * Dropped by migration 008.
 *
 * One row per check, not a history: `captured_at` is a column rather than
 * part of the key, and every write is an upsert.
 *
 * `level` and `note` are null for a check that does not judge. `message`
 * carries the failure text when `ok` is false.
 *
 * `level` has no CHECK constraint: its values come from `Verdict['level']`,
 * and a constraint would need a migration whenever that union changes.
 */
export const SQL = `
CREATE TABLE IF NOT EXISTS pgops.check_results (
  database_id int NOT NULL REFERENCES pgops.databases(id) ON DELETE CASCADE,
  check_id    text NOT NULL,
  captured_at timestamptz NOT NULL,
  ok          boolean NOT NULL,
  level       text,
  note        text,
  message     text,
  PRIMARY KEY (database_id, check_id)
);
`;
