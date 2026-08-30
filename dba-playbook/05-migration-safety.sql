-- =============================================================================
-- 05 — MIGRATION SAFETY: expand → backfill → contract   (console: nothing)
-- =============================================================================
-- This one is PREVENTIVE, not reactive — the work a careful DBA does BEFORE
-- shipping a schema change so it doesn't become files 00–01. There's no live
-- query to run; the "playbook" is a way of thinking about locks, plus a few
-- checks you run against the table you're about to alter.
--
-- The core fact (Part 3 §3.1 of plan): some DDL takes an ACCESS EXCLUSIVE lock,
-- which blocks EVERY read and write on the table — even plain SELECTs — for the
-- duration. On a small table that's milliseconds. On a 12M-row table it can be
-- ~45 seconds of total outage. The migration that's fine in staging is the one
-- that pages you in production, because the table is bigger there.
--
-- Read-only checks below. The ALTER statements are illustrations — DON'T run the
-- "naive" ones on anything you care about.
-- =============================================================================


-- THE TRAP: the innocent-looking statement that locks the world --------------
--   ALTER TABLE users ADD COLUMN email text NOT NULL DEFAULT '';
-- On older Postgres (< 11) and for any *volatile/non-constant* default, this
-- rewrites every row while holding ACCESS EXCLUSIVE — full table outage.
-- (PG 11+ made a *constant* default instant via metadata-only, but NOT NULL +
-- volatile defaults, type changes, and many other ALTERs still rewrite/block.)
--
-- THE SAFE PATTERN — three steps, never one:
--   1. EXPAND   — add the new thing in a non-blocking way (nullable column, or
--                 CREATE INDEX CONCURRENTLY). Takes only a weak lock.
--   2. BACKFILL — populate in small batches, each its own short transaction:
--                   UPDATE users SET email = '' WHERE id BETWEEN x AND y;
--                 Short row-level locks, no long ACCESS EXCLUSIVE, no waiters.
--   3. CONTRACT — once backfilled, add the NOT NULL / drop the old column / swap
--                 the app over. Validate constraints with NOT VALID first, then
--                 VALIDATE CONSTRAINT (which takes only a weak lock).


-- 1. HOW BIG IS THE TABLE YOU'RE ABOUT TO TOUCH? -----------------------------
-- The same DDL is "instant" or "outage" depending on size. Always check first.
SELECT
  s.relname                                        AS table,
  n_live_tup                                       AS approx_rows,
  pg_size_pretty(pg_total_relation_size(c.oid))    AS total_size
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
WHERE s.relname = 'users';      -- ← change to your target table
-- READ: thousands of rows → most ALTERs are fine. Millions+ → assume any
--       rewrite/ACCESS EXCLUSIVE statement is a measurable outage; use the
--       expand/backfill/contract dance instead.


-- 2. IS THE TABLE BUSY RIGHT NOW? --------------------------------------------
-- Even a fast metadata-only ALTER must briefly grab ACCESS EXCLUSIVE, which
-- means it has to WAIT for current statements to finish — and queues new ones
-- behind it. Running migrations during peak traffic turns a 10ms lock into a
-- pile-up. Check current activity on the table before you fire.
SELECT
  count(*) FILTER (WHERE state = 'active')               AS active_now,
  count(*) FILTER (WHERE state = 'idle in transaction')  AS idle_in_txn,
  max(now() - xact_start)                                AS oldest_txn
FROM pg_stat_activity
WHERE backend_type = 'client backend';
-- READ: an old idle-in-transaction (file 03) will make your ALTER hang waiting
--       for a lock it can't get — and while it waits, IT blocks everyone else.
--       Clear those first, and prefer a low-traffic window. Best practice: set a
--       short lock_timeout so a migration that can't get its lock fails fast
--       instead of stalling the table:
--         -- SET lock_timeout = '3s';


-- 3. DOES THE INDEX YOU'RE ADDING ALREADY EXIST? -----------------------------
-- Avoid an accidental duplicate index build (each is expensive). And when you do
-- build, build CONCURRENTLY so writes aren't blocked.
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'users';      -- ← your target table
-- Safe index build on a live table:
--   -- CREATE INDEX CONCURRENTLY idx_users_email ON users (email);
-- (CONCURRENTLY can't run inside a transaction block, takes longer, and can
-- leave an INVALID index if it fails — re-check pg_indexes and DROP/retry.)


-- 4. THE PATTERNS TO CATCH IN CODE REVIEW ------------------------------------
-- No pgops surface covers this one: the console reads a live database, it does
-- not read your migration files. These are the shapes to catch by eye, each
-- rewritten as THE SAFE PATTERN at the top of this file:
--
--   UNSAFE                                          WHY
--   ADD COLUMN ... NOT NULL (volatile default)      full rewrite, ACCESS EXCLUSIVE
--   ALTER COLUMN ... TYPE ...                        full rewrite
--   CREATE INDEX (without CONCURRENTLY)              blocks writes for the build
--   DROP COLUMN                                       ACCESS EXCLUSIVE, hides bugs
--   ADD CONSTRAINT ... (without NOT VALID first)     validates under a strong lock
--
-- The whole point: catch the naive single-statement version in code review,
-- before it's the lock chain you're untangling in file 01 at 2am.
-- =============================================================================
