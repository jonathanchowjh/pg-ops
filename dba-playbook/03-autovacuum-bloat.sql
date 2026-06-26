-- =============================================================================
-- 03 — AUTOVACUUM & BLOAT DOCTOR   (→ pgops vacuum)
-- =============================================================================
-- Symptom: tables feel bloated, disk creeps up, or a table is slow despite good
-- indexes. Two distinct worries live here:
--   (1) BLOAT — dead rows piling up faster than autovacuum reclaims them.
--   (2) WRAPAROUND — the 32-bit transaction-ID counter aging toward the limit.
--       This one can SHUT THE DATABASE DOWN to protect data. It's the scarier of
--       the two and the one juniors don't know to watch.
--
-- Why dead rows exist at all: Postgres MVCC never overwrites a row in place. An
-- UPDATE writes a new version and marks the old "dead." VACUUM reclaims dead
-- rows. If something pins old transactions open (the classic: a client stuck
-- 'idle in transaction'), vacuum can't reclaim, and bloat grows unbounded.
--
-- All read-only except the manual VACUUM at the end (commented, and non-blocking).
-- =============================================================================


-- 1. BLOAT TRIAGE: dead tuples per table -------------------------------------
-- pg_stat_user_tables tracks live vs dead tuples and the last (auto)vacuum.
-- High dead_pct + an old last_autovacuum = autovacuum is falling behind here.
SELECT
  relname                                                      AS table,
  n_live_tup                                                   AS live,
  n_dead_tup                                                   AS dead,
  CASE WHEN n_live_tup > 0
       THEN round(100.0 * n_dead_tup / n_live_tup, 1)
       ELSE 0 END                                              AS dead_pct,
  last_vacuum,
  last_autovacuum,
  vacuum_count,
  autovacuum_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 15;
-- READ: dead_pct above ~20% on a table that matters, with a stale
--       last_autovacuum, means autovacuum isn't keeping up. Before tuning,
--       always check WHY (query 3) — usually something is pinning transactions.


-- 2. WRAPAROUND HORIZON: the one that can take you down -----------------------
-- Every table has a relfrozenxid — the oldest unfrozen transaction id in it.
-- As the global txn counter advances, that age grows. At
-- autovacuum_freeze_max_age (default 200M) an aggressive "anti-wraparound"
-- autovacuum kicks in. If age ever reaches ~2.1 billion, Postgres refuses new
-- writes to protect against id reuse. You want to act long before that.
SELECT
  c.relname                                            AS table,
  age(c.relfrozenxid)                                  AS xid_age,
  current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
  round(100.0 * age(c.relfrozenxid)
        / current_setting('autovacuum_freeze_max_age')::bigint, 1) AS pct_to_forced_vacuum,
  pg_size_pretty(pg_total_relation_size(c.oid))        AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'm')                          -- tables + matviews
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
ORDER BY age(c.relfrozenxid) DESC
LIMIT 15;
-- READ: pct_to_forced_vacuum approaching 100 → an anti-wraparound vacuum is
--       imminent (or overdue). On a huge table that's a long, IO-heavy job you'd
--       rather schedule than have ambush you. Nowhere near 100 → no wraparound
--       worry; focus on bloat (query 1).


-- 3. WHY VACUUM CAN'T KEEP UP: the usual culprit ------------------------------
-- Vacuum can only reclaim rows older than the oldest transaction still running.
-- A single ancient 'idle in transaction' session holds the horizon back for the
-- WHOLE database. This is the #1 preventable cause of runaway bloat.
SELECT
  pid,
  usename,
  application_name,
  state,
  now() - xact_start             AS txn_age,     -- how long it's pinned the horizon
  now() - state_change           AS idle_for,
  left(query, 60)                AS last_query
FROM pg_stat_activity
WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
ORDER BY xact_start ASC;        -- oldest first = worst offender
-- READ: an idle-in-transaction session many minutes (or hours) old is your
--       cause. The fix is usually to fix the APP (it forgot to COMMIT/ROLLBACK),
--       but to stop the bleeding now you can terminate it (see 01 for the how
--       and the caveats):
--         -- SELECT pg_terminate_backend(<PID>);


-- 4. CHECK THE PER-TABLE AUTOVACUUM SETTINGS (context) ------------------------
-- Autovacuum triggers when dead tuples exceed
-- autovacuum_vacuum_threshold + scale_factor * n_live_tup. On a huge table the
-- default scale_factor (0.2 = 20%) means it waits for a LOT of dead rows. Big,
-- hot tables usually want a per-table override lowering the scale factor.
SELECT
  relname                        AS table,
  reloptions                     AS per_table_overrides   -- NULL = using global defaults
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND reloptions IS NOT NULL;
-- (Empty result just means no table has overrides yet — common.)


-- 5. THE ACTIONS (you choose; these are commented out) ------------------------
--   (a) Kill the idle-in-transaction holder (query 3)        → unpins vacuum.
--   (b) Manual vacuum to catch up NOW (non-blocking, online):
--         -- VACUUM (VERBOSE, ANALYZE) users;
--       VACUUM does NOT take an exclusive lock; reads and writes continue. (Only
--       VACUUM FULL rewrites the table under ACCESS EXCLUSIVE — avoid on live
--       tables.) VERBOSE prints what it reclaimed; ANALYZE also refreshes stats.
--   (c) Tune so autovacuum keeps up without you (per-table override):
--         -- ALTER TABLE users SET (autovacuum_vacuum_scale_factor = 0.05);
--
-- `pgops vacuum` is this triage as a two-pane TUI: tables ranked by bloat risk,
-- wraparound horizon bar, and an advise line ("run VACUUM ANALYZE users — 42%
-- dead tuples, last successful 14 days ago").
-- =============================================================================
