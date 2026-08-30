-- =============================================================================
-- 00 — THE FIRST FIVE MINUTES
-- =============================================================================
-- A page fired. "The database feels wrong." You don't yet know if it's locks,
-- a slow query, vacuum, replication, or just load. This file is the triage
-- pass: a handful of cheap, read-only queries whose answers tell you WHICH of
-- the other files to open next.
--
-- A DBA runs roughly these, in this order, from memory. The pgops console's
-- Triage page (/db/<name>) answers most of them at a glance; this file is the
-- orientation itself — the pass that decides which file below to open next.
--
-- Safe to run anywhere. All read-only. Run top to bottom.
-- =============================================================================


-- 1. WHO IS CONNECTED, AND WHAT ARE THEY DOING? ------------------------------
-- pg_stat_activity = one row per session. This is the single most-run query in
-- a DBA's life. 'state' is the tell:
--   active             → running a query right now
--   idle               → connected, doing nothing (fine)
--   idle in transaction → ran BEGIN, then stopped. DANGER: pins vacuum,
--                         can hold locks. The single biggest cause of
--                         preventable bloat and lock pile-ups.
SELECT
  state,
  count(*)                                  AS sessions,
  max(now() - state_change)                 AS longest_in_state
FROM pg_stat_activity
WHERE backend_type = 'client backend'       -- ignore Postgres' own workers
GROUP BY state
ORDER BY sessions DESC;
-- READ: lots of 'active'? → load or slow queries (open 02).
--       any 'idle in transaction' older than a few minutes? → a stuck client
--       is about to cause lock/bloat problems (open 01, then 03).


-- 2. IS ANYTHING BLOCKED RIGHT NOW? ------------------------------------------
-- pg_blocking_pids() (PG 9.6+) is the fast yes/no for "is there lock
-- contention." If this returns any rows, you have a lock chain — open 01.
SELECT
  pid,
  now() - query_start            AS waiting_for,
  wait_event_type,
  wait_event,
  left(query, 80)                AS blocked_query,
  pg_blocking_pids(pid)          AS blocked_by
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
ORDER BY waiting_for DESC;
-- READ: any rows → lock contention. The 'blocked_by' PIDs are your suspects.
--       open 01-lock-chain.sql to walk the full chain to the root blocker.


-- 3. THE LONGEST-RUNNING QUERIES RIGHT NOW -----------------------------------
-- Not aggregate stats (that's 02) — live, in-flight queries that have been
-- running a suspiciously long time. A 40-minute SELECT during an incident is
-- often the cause, not a victim.
SELECT
  pid,
  now() - query_start            AS running_for,
  state,
  wait_event_type,
  left(query, 100)               AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND backend_type = 'client backend'
  AND now() - query_start > interval '5 seconds'
ORDER BY running_for DESC
LIMIT 10;
-- READ: a long-running query that everything else waits behind is a candidate
--       to kill (see 01 for how, and why you confirm first).


-- 4. CONNECTION HEADROOM ------------------------------------------------------
-- "FATAL: too many connections" is its own incident. Are we near the cap?
-- Postgres is process-per-connection, so the cap is real and low (often 100).
SELECT
  count(*)                                                   AS used,
  current_setting('max_connections')::int                   AS max,
  current_setting('max_connections')::int - count(*)        AS headroom
FROM pg_stat_activity;
-- READ: headroom near zero → you may need a pooler (pgbouncer) or to kill idle
--       sessions. A flood of 'idle' connections from an app without a pool is
--       the usual cause.


-- 5. BIGGEST TABLES (context, not a symptom) ---------------------------------
-- Useful background during any incident: a "slow query" or "bad vacuum" on a
-- 2 TB table is a different problem than on a 2 MB one. pg_total_relation_size
-- includes indexes and TOAST.
SELECT
  s.relname                                            AS table,
  pg_size_pretty(pg_total_relation_size(c.oid))        AS total_size,
  n_live_tup                                           AS approx_rows
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 10;


-- =============================================================================
-- WHERE TO GO NEXT
-- -----------------------------------------------------------------------------
--   Query 2 returned rows  ............  01-lock-chain.sql
--                                        (console: /db/<name>/locks)
--   Query 1/3 show slow active queries   02-slow-queries.sql
--                                        (console: /db/<name>/queries)
--   "idle in transaction" + bloat fears  03-autovacuum-bloat.sql
--                                        (console: nothing for bloat)
--   Replica lag / disk on primary  ....  04-replication-slots.sql
--                                        (console: "Replication slots" on /db/<name>)
--   About to ship a migration  ........  05-migration-safety.sql
--                                        (console: nothing — it reads databases,
--                                         not migration files)
-- =============================================================================
