-- =============================================================================
-- 01 — THE INCIDENT LOCK CHAIN   (console: /db/<name>/locks)
-- =============================================================================
-- Symptom: "Writes are timing out." Query 2 of the triage file found blocked
-- sessions. Now you walk the chain: who is waiting, on whom, all the way to the
-- ROOT BLOCKER — the one session that is blocking others but is itself blocked
-- by no one. That's the session you decide to wait out or kill.
--
-- This is the killer use case for pgops. By hand it's a CTE most DBAs keep in a
-- snippets file because nobody memorizes it. Below is a readable version.
--
-- TO SEE THIS DO SOMETHING: you need live contention. In another terminal:
--   npm run db:seed      (holds a real lock chain open; Ctrl-C to release)
-- then run this file against the same DATABASE_URL.
--
-- Reads are safe anywhere. The kill at the bottom is commented OUT.
-- =============================================================================


-- 1. THE FAST ANSWER: who is blocked, and by whom ----------------------------
-- pg_blocking_pids() does the graph walk for you. Good enough to identify the
-- root blocker in simple cases (one blocker, N waiters).
SELECT
  pid                            AS waiter_pid,
  pg_blocking_pids(pid)          AS blocked_by_pids,
  now() - query_start            AS waiting_for,
  left(query, 80)                AS waiter_query
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
ORDER BY waiting_for DESC;


-- 2. THE FULL CHAIN: join pg_locks to itself ---------------------------------
-- pg_blocking_pids hides the lock detail. To see WHICH lock and WHAT MODE (and
-- to render a tree, as the console's Locks page does), join the lock table to
-- itself: every
-- un-granted lock (a waiter) matched to the granted lock blocking it.
--
-- This is the heart of the console's Locks page — the same shape as the
-- production CTE in Part 1 §A1 of the plan, trimmed for reading.
SELECT
  waiter.pid                                   AS waiter_pid,
  waiter_act.usename                           AS waiter_user,
  waiter_act.application_name                  AS waiter_app,
  now() - waiter_act.xact_start                AS waiter_txn_age,
  waiter.mode                                  AS wants_mode,
  blocker.pid                                  AS blocker_pid,
  blocker_act.usename                          AS blocker_user,
  blocker_act.application_name                 AS blocker_app,
  blocker.mode                                 AS holds_mode,
  blocker.relation::regclass                   AS on_table,
  left(blocker_act.query, 60)                  AS blocker_query
FROM pg_locks waiter
JOIN pg_locks blocker
       ON  waiter.locktype           IS NOT DISTINCT FROM blocker.locktype
       AND waiter.database           IS NOT DISTINCT FROM blocker.database
       AND waiter.relation           IS NOT DISTINCT FROM blocker.relation
       AND waiter.transactionid      IS NOT DISTINCT FROM blocker.transactionid
       AND waiter.pid <> blocker.pid
JOIN pg_stat_activity waiter_act  ON waiter_act.pid  = waiter.pid
JOIN pg_stat_activity blocker_act ON blocker_act.pid = blocker.pid
WHERE NOT waiter.granted             -- the waiter is stuck...
  AND blocker.granted                -- ...behind a lock that IS held
ORDER BY waiter_txn_age DESC;
-- READ: the ROOT BLOCKER is a blocker_pid that never appears as a waiter_pid.
--       Note its app + query + how long its transaction has been open. A blocker
--       holding ACCESS EXCLUSIVE (a migration) blocks even SELECTs. A blocker
--       that is 'idle in transaction' is a stuck client, not real work — prime
--       candidate to kill.


-- 3. INSPECT THE BLOCKER BEFORE YOU TOUCH IT ---------------------------------
-- Never kill blind. Pull the full picture of the suspected root blocker.
-- Replace <PID> with the blocker_pid from query 2.
--
-- SELECT pid, usename, application_name, client_addr,
--        state, now() - xact_start AS txn_age, wait_event_type, query
-- FROM   pg_stat_activity
-- WHERE  pid = <PID>;
--
-- READ before acting:
--   - state = 'idle in transaction' → safe-ish to kill; it's a stuck client.
--   - state = 'active' with a real query → killing it rolls back real work.
--   - application_name tells you whose it is (batch job? a human in psql?).


-- 4. THE DECISION --------------------------------------------------------------
-- You have three moves:
--   (a) WAIT     — if the blocker will finish on its own soon. Cheapest.
--   (b) KILL     — terminate the blocker; its waiters proceed immediately.
--   (c) ESCALATE — page the team that owns the blocking app.
--
-- KILL is irreversible: it rolls back the blocker's transaction. Two flavors:
--   pg_cancel_backend(pid)     → cancels the current QUERY (gentler; the
--                                session and its transaction survive). Try first.
--   pg_terminate_backend(pid)  → kills the whole SESSION. Use when cancel isn't
--                                enough (e.g. idle-in-transaction has no query
--                                to cancel).
--
-- Killing the ROOT blocker is enough — its waiters were never the problem, so
-- never mass-kill the waiters. One backend, deliberately.
--
-- Uncomment ONE line, with the real PID, only after step 3:
--
-- SELECT pg_cancel_backend(<PID>);       -- gentle: cancel the query
-- SELECT pg_terminate_backend(<PID>);    -- hard: kill the session
--
-- The console's one write action is this statement. It lives on the Sessions
-- page (/db/<name>/sessions), not the Locks page, and only appears when the
-- deployment sets PGOPS_ALLOW_ACTIONS=true. It is an inline two-step, not a
-- modal: you type a required free-text reason next to the row and then press
-- Confirm, and the kill is pinned to the session identity (backend_start) that
-- row was showing, so a recycled pid comes back refused rather than killed.
-- Every attempt is audited, success or failure.
-- Requires the pg_signal_backend role (or superuser) to signal others' backends.
-- =============================================================================
