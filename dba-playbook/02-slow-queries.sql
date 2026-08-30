-- =============================================================================
-- 02 — SLOW-QUERY TRIAGE   (console: /db/<name>/queries)
-- =============================================================================
-- Symptom: "Endpoint X is slow," usually from an APM (Datadog, New Relic). The
-- app points at a feature; your job is to find the guilty SQL and the fix.
--
-- The tool is pg_stat_statements: an extension that aggregates timing across
-- EVERY execution of each query shape (literals stripped). Unlike
-- pg_stat_activity (live, one row per session), this is cumulative history —
-- "which query shape has cost us the most time overall."
--
-- Requires the extension. The dev DB (npm run db:up) preloads it. To verify:
--   SELECT * FROM pg_extension WHERE extname = 'pg_stat_statements';
-- If empty: it needs shared_preload_libraries + a restart + CREATE EXTENSION.
-- That install dance is itself a classic DBA task (see Part 3 §1.10 of plan).
--
-- All read-only.
-- =============================================================================


-- 0. Make sure the extension is here (and create it if preloaded but not yet
-- created in this database — CREATE EXTENSION is per-database).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;


-- 1. THE WORKHORSE: top queries by TOTAL time --------------------------------
-- "Total time" = mean time × number of calls. This surfaces the queries that
-- cost the most in aggregate — usually a moderately-slow query run constantly,
-- which is what actually melts a database. Order by this first.
SELECT
  left(query, 70)                                        AS query,
  calls,
  round(total_exec_time)                                 AS total_ms,
  round(mean_exec_time::numeric, 2)                      AS mean_ms,
  round(100.0 * shared_blks_hit
        / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct,
  rows
FROM pg_stat_statements
WHERE query NOT LIKE '%pg_stat_statements%'             -- ignore our own probing
ORDER BY total_exec_time DESC
LIMIT 15;
-- READ:
--   high total_ms + high calls + low mean → a hot path; caching or an index helps.
--   low cache_hit_pct (< ~95%) → the query is reading from disk, not memory;
--      often a missing index forcing a sequential scan over a big table.
--   high mean_ms → one expensive query; the next query finds the rare-but-heavy.


-- 2. THE OTHER ANGLE: top queries by MEAN time -------------------------------
-- A query run 3 times a day but taking 40s each won't top the total-time list,
-- yet it's the one a user is staring at. Filter out the trivially-rare so a
-- single warm-up call doesn't dominate.
SELECT
  left(query, 70)        AS query,
  calls,
  round(mean_exec_time)  AS mean_ms,
  round(stddev_exec_time) AS stddev_ms,   -- high stddev = inconsistent (plan flips, lock waits)
  rows / nullif(calls, 0) AS avg_rows
FROM pg_stat_statements
WHERE calls > 5
ORDER BY mean_exec_time DESC
LIMIT 15;


-- 3. DIAGNOSE THE SUSPECT: EXPLAIN -------------------------------------------
-- Found the guilty query? Get its plan. EXPLAIN alone shows the planner's
-- predicted plan (no execution). EXPLAIN (ANALYZE, BUFFERS) actually runs it
-- and shows real times + cache behavior — but it RUNS the query, so don't
-- ANALYZE a destructive statement, and beware on very slow ones.
--
-- Paste your real query in place of the example:
--
-- EXPLAIN (ANALYZE, BUFFERS)
-- SELECT * FROM users WHERE email = 'someone@example.com';
--
-- READ the plan BOTTOM-UP (most-indented nodes run first). Red flags:
--   Seq Scan on a large table     → missing/unused index on the filter column
--   rows estimate wildly off       → stale planner stats; run ANALYZE <table>
--   Nested Loop over many rows     → bad join order or missing index on join key
--   "Buffers: read=" large         → reading from disk; corroborates low cache hit


-- 4. THE FIX (you write it; these don't run) ---------------------------------
-- Three usual outcomes, in rough order of preference:
--   (a) ADD AN INDEX. On a live large table, ALWAYS build concurrently so it
--       doesn't block writes:
--         CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
--       (Plain CREATE INDEX takes SHARE and blocks all writes for the build.)
--   (b) REFRESH STATS. If the row estimates were wrong, the planner is guessing:
--         ANALYZE users;
--   (c) REWRITE the query — remove a function wrapped around an indexed column,
--       avoid SELECT *, add a LIMIT, fix an accidental cross join.
--
-- The console's Queries page (/db/<name>/queries) is the OBSERVE half of this
-- loop: the same pg_stat_statements rows, sortable by total, mean or calls,
-- with every query redacted before it renders. It has no EXPLAIN view — steps
-- (a)-(c) above stay yours to run here, in psql.


-- (Optional) If a deploy changed the workload and you want a clean baseline:
--   SELECT pg_stat_statements_reset();   -- wipes the stats; commented out.
-- =============================================================================
