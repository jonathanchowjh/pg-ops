-- =============================================================================
-- 04 — REPLICATION SLOT HEALTH   (console: "Replication slots" on /db/<name>)
-- =============================================================================
-- Symptom: a replica is lagging, OR — the scary one — disk is steadily filling
-- on the PRIMARY for no obvious reason. Both lead here.
--
-- Background you need (Part 3 §3.2 of plan):
--   WAL  = the write-ahead log; every change is written here first.
--   A REPLICATION SLOT is the primary's bookkeeping for one consumer (a replica,
--     or a CDC pipeline to Kafka/Snowflake). The slot guarantees the primary
--     KEEPS WAL until the consumer confirms it has read up to that point.
--   THE KILLER SCENARIO: the consumer dies but the slot remains. The primary
--     dutifully retains WAL forever, waiting for a consumer that's never coming.
--     WAL piles up, disk fills, and eventually the PRIMARY crashes. An orphaned
--     slot is one of the few ways a read replica's problem takes down the writer.
--
-- All read-only. The slot DROP at the end is commented out and is destructive.
-- =============================================================================


-- 1. EVERY SLOT AND HOW FAR BEHIND IT IS -------------------------------------
-- pg_replication_slots is the slot inventory. The crucial derived number is the
-- lag in BYTES: how much WAL the primary is retaining because of this slot,
-- measured as the distance from the current WAL position to where the slot has
-- confirmed. Growing lag = growing disk usage.
SELECT
  slot_name,
  slot_type,                                  -- 'logical' (CDC) or 'physical' (replica)
  plugin,                                      -- decoder for logical slots
  active,                                      -- is a consumer connected RIGHT NOW?
  active_pid,
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
  )                                            AS retained_wal,
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
  )                                            AS lag
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST;
-- READ the danger row:
--   active = false  AND  retained_wal large and growing  →  ORPHAN SLOT.
--      Nothing is consuming it, yet it's pinning gigabytes of WAL. This is the
--      one that wakes you at 2am. Confirm the consumer is truly gone (query 3),
--      then drop it (query 4).
--   active = true   AND  lag large  →  consumer is alive but slow/falling
--      behind. Different problem: investigate the replica/pipeline, don't drop.
-- NOTE: on a fresh dev DB this table is usually EMPTY (no replication set up) —
-- that's the healthy "nothing to worry about" answer.


-- 2. HOW MUCH DISK DOES WAL OCCUPY RIGHT NOW? --------------------------------
-- Corroborate "disk filling" — is WAL actually the thing growing?
SELECT
  count(*)                                   AS wal_segments,
  pg_size_pretty(sum(size))                  AS wal_on_disk
FROM pg_ls_waldir();
-- READ: if this is large and climbing in step with a slot's retained_wal from
--       query 1, the slot is the cause. (max_slot_wal_keep_size, PG 13+, can
--       cap this — a slot that exceeds it is invalidated rather than crashing
--       the primary. Check: SHOW max_slot_wal_keep_size; '-1' = unbounded.)


-- 3. CROSS-CHECK: are the physical replicas actually connected? ---------------
-- pg_stat_replication has one row per CONNECTED streaming standby. If a slot
-- claims to be for a replica but that replica isn't in this list, the consumer
-- is gone — the slot is an orphan.
SELECT
  application_name,
  client_addr,
  state,                                     -- 'streaming' = healthy
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
  )                                          AS replica_lag
FROM pg_stat_replication;
-- READ: a slot from query 1 whose consumer has no matching row here = orphan.


-- 4. THE DECISION: drop only a confirmed-dead slot ----------------------------
-- Dropping a slot frees the retained WAL immediately. But dropping a slot whose
-- consumer is merely slow (not dead) BREAKS replication for it — the replica
-- can never catch up and must be rebuilt. So the rule is strict:
--   drop ONLY when active = false AND you've confirmed (query 3, plus knowing
--   your infra) that the consumer is genuinely, permanently gone.
--
-- Uncomment with the real slot name, only after confirming:
--   -- SELECT pg_drop_replication_slot('etl_to_snowflake');
--
-- The console's "Replication slots" panel (/db/<name>) shows each slot with its
-- type, whether a consumer is attached, and the WAL it is retaining — computed
-- for EVERY slot, active or not, because the failure that fills a primary's
-- disk is an attached consumer that has stopped advancing. It reports the
-- retained bytes it can see right now; it does not track growth over time, so
-- there is no "disk full in 14h" forecast. Query 2 below is the same reading,
-- by hand.
-- =============================================================================
