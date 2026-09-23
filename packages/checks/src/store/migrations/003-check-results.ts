/**
 * Migration 003 — the hygiene cache.
 *
 * The 21 `class: 'hygiene'` checks are catalog scans. They run on visit, so
 * until something stores what they found, a duplicate index or a sequence
 * approaching its ceiling is invisible until somebody opens the page that
 * looks for it — and the page an operator actually opens is triage. This
 * table is what lets triage report a hygiene finding it did not run.
 *
 * ONE ROW PER CHECK, NOT A HISTORY. `query_stats` and `space_stats` both key
 * on `captured_at` because their whole purpose is a series. Nothing reads a
 * hygiene finding from last Tuesday: the question is "what did the last pass
 * find", so `captured_at` is a column rather than part of the key and every
 * write is an upsert. Keyed by time instead, 21 checks per database at the
 * five-minute cadence would be ~85,000 rows a fortnight to answer a
 * latest-row query, plus a prune to keep them from becoming millions.
 *
 * No index beyond the primary key. `(database_id, check_id)` serves the only
 * two reads there are — every row for one database, and one check's row —
 * and a table with one row per check per database is small by construction.
 *
 * `level` and `note` are nullable because a check with no verdict is the
 * normal case, not a defect: 15 of the 21 report a reading and never judge
 * (spec 2026-09-03 §1.1). `message` carries the failure text when `ok` is
 * false, because "we could not look" is a reading the triage line has to
 * show — a failed check that simply was not written would leave the previous
 * pass's verdict sitting there reading as current.
 *
 * `ok` is NOT NULL and `level` is left unconstrained by CHECK: the values
 * come from `Verdict['level']`, which the type system already pins at the one
 * call site that writes them, and a CHECK constraint here would have to be
 * migrated every time that union gains a member.
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
