import { describe, expect, it } from 'vitest';
import { HEALTH_METRICS, toHealthPoints, type BucketRow } from '../src/series/health.js';

/** A bucket row with every figure null, then the ones a test cares about. */
function bucket(n: number, over: Partial<BucketRow>): BucketRow {
  const keys = [
    'connections', 'server_connections', 'max_connections', 'blocked', 'longest_wait_secs', 'idle_in_txn',
    'active', 'longest_query_secs', 'replication_lag_secs', 'xid_age', 'xmin_age', 'size_bytes',
  ];
  const counters = [
    'sessions', 'sessions_abandoned', 'sessions_fatal', 'sessions_killed', 'idle_in_transaction_time',
    'deadlocks', 'active_time', 'xact_commit', 'xact_rollback', 'blks_hit', 'blks_read', 'temp_bytes',
    'wal_bytes', 'own_statements',
  ];
  const blank = Object.fromEntries([
    ...keys.map((k) => [k, null]),
    ...counters.flatMap((c) => [[c, null], [`${c}_secs`, null]]),
  ]);
  return { name: 'prod', bucket: n, rows: 2, ...blank, ...over } as BucketRow;
}

describe('toHealthPoints', () => {
  it('returns one point per bucket, null where no row fell', () => {
    const points = toHealthPoints([bucket(2, { blocked: 3 })], 0, 480_000, 4);
    expect(points.map((p) => p.at)).toEqual([0, 120_000, 240_000, 360_000]);
    expect(points.map((p) => p.blocked)).toEqual([null, 3, null, null]);
    for (const m of HEALTH_METRICS) expect(points[0]![m]).toBeNull();
  });

  it('turns a counter sum into a rate over the seconds it covers', () => {
    const [p] = toHealthPoints([bucket(1, { xact_commit: 1200, xact_commit_secs: 120 })], 0, 120_000, 1);
    expect(p!.commitsPerSec).toBe(10);
  });

  it('reads active_time as average sessions: milliseconds of activity per second', () => {
    const [p] = toHealthPoints([bucket(1, { active_time: 240_000, active_time_secs: 120 })], 0, 120_000, 1);
    expect(p!.avgActive).toBe(2);
  });

  it('gives no rate, not zero, when no interval in the bucket was valid', () => {
    const [p] = toHealthPoints([bucket(1, { xact_commit: null, xact_commit_secs: null })], 0, 120_000, 1);
    expect(p!.commitsPerSec).toBeNull();
  });

  it('gives no hit rate when nothing was read at all', () => {
    const [idle] = toHealthPoints([bucket(1, {
      blks_hit: 0, blks_hit_secs: 120, blks_read: 0, blks_read_secs: 120,
    })], 0, 120_000, 1);
    expect(idle!.hitPct).toBeNull();
    const [busy] = toHealthPoints([bucket(1, {
      blks_hit: 90, blks_hit_secs: 120, blks_read: 10, blks_read_secs: 120,
    })], 0, 120_000, 1);
    expect(busy!.hitPct).toBe(90);
  });

  it('counts sessions that ended badly across all three ways', () => {
    const [p] = toHealthPoints([bucket(1, {
      sessions_abandoned: 2, sessions_abandoned_secs: 120,
      sessions_fatal: 1, sessions_fatal_secs: 120,
      sessions_killed: null, sessions_killed_secs: null,
    })], 0, 120_000, 1);
    expect(p!.badSessions).toBe(3);
  });
});
