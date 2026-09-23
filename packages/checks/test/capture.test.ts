import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { captureOnce, checkResultRow, queryLoadRow } from '../src/capture.js';
import type { CounterPoint } from '../src/series/query-stats.js';
import type { QueryStatsSnapshot } from '../src/store/write.js';
import type { CheckContext } from '../src/types.js';

/**
 * Node raises an AggregateError with an EMPTY `.message` when a host resolves
 * to several addresses and every connect attempt fails — `::1` and
 * `127.0.0.1` both refused. That is not an exotic case for the STORE: it is
 * what `PGOPS_STORE_URL=postgres://localhost/pgops` produces when nothing is
 * listening, which is the single likeliest way to misconfigure it.
 *
 * `err instanceof Error ? err.message : String(err)` returns `''` for it —
 * AggregateError IS an Error and its own message is empty — so capture
 * reported the failure with no reason attached, and the scheduler logged a
 * blank. run.ts has unwrapped this since P0 for exactly the same reason on
 * the check path; capture had its own copy that did not.
 */
function refusedOnBothStacks(): AggregateError {
  return new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
  ]);
}

/** Only `store.connect` is reached before the failure under test. */
function ctxWithStore(connect: () => Promise<never>): CheckContext {
  return {
    target: { query: async () => ({ rows: [] }) } as never,
    store: { connect } as never,
    serverVersion: 170000,
  };
}

describe('captureOnce', () => {
  it('reports why the store connection failed, not an empty message', async () => {
    const outcome = await captureOnce(
      ctxWithStore(async () => { throw refusedOnBothStacks(); }),
      'app',
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'unreachable' });
    if (outcome.ok === false) {
      expect(outcome.message).toContain('ECONNREFUSED ::1:5432');
      expect(outcome.message).toContain('ECONNREFUSED 127.0.0.1:5432');
    }
  });

  it('still reports an ordinary connect error unchanged', async () => {
    const outcome = await captureOnce(
      ctxWithStore(async () => { throw new Error('password authentication failed for user "pgops"'); }),
      'app',
    );
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'unreachable',
      message: 'password authentication failed for user "pgops"',
    });
  });
});

/**
 * A fake store client that is a real EventEmitter, because the hazard IS the
 * EventEmitter contract: an 'error' event with no listener is fatal to the
 * process, and pg-pool removes the client's own listener for exactly as long
 * as the client is checked out.
 */
class FakeStoreClient extends EventEmitter {
  released = 0;
  async query(text: string): Promise<{ rows: unknown[] }> {
    if (text.includes('INSERT INTO pgops.databases')) return { rows: [{ id: 1 }] };
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (text.includes('SELECT now()')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  }
  release(): void { this.released += 1; }
}

describe('captureOnce holds its store client safely', () => {
  /**
   * The store connection dropping WHILE the capture is in flight.
   *
   * capture.ts holds one store client across both scans of the monitored
   * database and the whole write transaction — seconds at a time, every five
   * minutes, forever. pg emits 'error' directly on the client when that
   * connection dies, from a socket callback that sits in no try/catch of
   * ours, and a checked-out client has no listener of its own. So the failure
   * mode was not a failed capture: it was the web process exiting, on the one
   * file whose docblock promises it NEVER throws because "an unhandled
   * rejection there terminates the web process".
   *
   * `setImmediate` is load-bearing. Emitting inline would land the throw
   * inside captureOnce's own try/catch and the test would pass against the
   * unguarded version — proving nothing. Emitting from a macrotask is what
   * reproduces pg's actual delivery, where nothing of ours is on the stack.
   */
  it('does not take the process down when the connection drops mid-capture', async () => {
    const client = new FakeStoreClient();
    const target = {
      query: async (text: string) => {
        if (text.includes('pg_class')) {
          // The store dies while we are scanning the monitored database.
          setImmediate(() => client.emit('error', new Error('connection terminated unexpectedly')));
          await new Promise((r) => { setTimeout(r, 10); });
        }
        return { rows: [] };
      },
    };
    const ctx = {
      target, store: { connect: async () => client }, serverVersion: 170000,
    } as unknown as CheckContext;

    // The capture itself still completes — the dropped connection is the
    // STORE's own client, and nothing in this pass asked it for anything
    // after the drop. What matters is that no unhandled 'error' escaped.
    await expect(captureOnce(ctx, 'app')).resolves.toBeDefined();
    // And the listener came off again, so a reused connection cannot
    // accumulate one per capture.
    expect(client.listenerCount('error')).toBe(0);
    expect(client.released).toBe(1);
  });
});

/**
 * The dropped-relation race, staged deterministically for the first time.
 *
 * `capture.int.test.ts` says of this case: "a race no test can stage
 * deterministically, and deliberately NOT asserted here rather than asserted
 * by something that cannot fail." That was true while the guard was
 * `pg_total_relation_size(c.oid) IS NOT NULL` in SPACE_SQL — you cannot make
 * a real Postgres drop a table between the WHERE and the select list on
 * demand. It is a plain row once the guard moves into `captureOnce`, and a
 * null `size_bytes` is what the database actually returns for it.
 *
 * `Number(null)` is 0, so the defect this prevents is not a crash: it is a
 * relation recorded at zero bytes, which on a space chart reads as the table
 * shrinking to nothing rather than as pgops never having measured it.
 */
describe('captureOnce and a relation dropped mid-scan', () => {
  it('stores no snapshot for a relation it could not measure', async () => {
    const client = new FakeStoreClient();
    const stored: unknown[][] = [];
    client.query = async (text: string): Promise<{ rows: unknown[] }> => {
      if (text.includes('INSERT INTO pgops.databases')) return { rows: [{ id: 1 }] };
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (text.includes('SELECT now()')) return { rows: [{ now: new Date() }] };
      return { rows: [] };
    };
    const target = {
      query: async (text: string) => {
        if (text.includes('pg_class')) {
          return {
            rows: [
              { relation: 'public.alive', size_bytes: '8192' },
              // Dropped between the pg_class scan and the size call.
              { relation: 'public.gone', size_bytes: null },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const ctx = {
      target, store: { connect: async () => client }, serverVersion: 170000,
    } as unknown as CheckContext;

    const captured: unknown[] = [];
    const origQuery = client.query.bind(client);
    client.query = async (text: string, values?: unknown[]) => {
      if (text.includes('INSERT INTO pgops.space_stats')) {
        captured.push(...(values ?? []));
        stored.push(values ?? []);
      }
      return origQuery(text);
    };

    const outcome = await captureOnce(ctx, 'app');
    // One relation measured, one omitted — not two with a zero.
    expect(outcome).toMatchObject({ ok: true, relations: 1 });
    expect(captured).toContain('public.alive');
    expect(captured).not.toContain('public.gone');
    // And nothing was stored as 0 bytes.
    expect(captured).not.toContain(0);
  });
});


/**
 * The cache stores what a check FOUND, including that it found nothing
 * because it could not look. The failure branch is here rather than in the
 * integration test because provoking a real privilege error mid-pass is
 * awkward, and this is where the distinction actually lives.
 */
describe('checkResultRow', () => {
  const measuredAt = Date.now();

  it('stores a failed check with its message and no level', () => {
    expect(checkResultRow('indexHitRate', {
      ok: false, reason: 'privilege', message: 'permission denied for pg_statio_user_indexes',
    })).toEqual({
      checkId: 'indexHitRate',
      ok: false,
      level: null,
      note: null,
      message: 'permission denied for pg_statio_user_indexes',
    });
  });

  it('stores a verdict with its note', () => {
    expect(checkResultRow('unusedIndexes', {
      ok: true, data: {}, measuredAt, verdict: { level: 'warn', note: '2 unused indexes' },
    })).toMatchObject({ ok: true, level: 'warn', note: '2 unused indexes', message: null });
  });

  /**
   * A reading, not a judgement. `level: null` is what keeps "we do not judge"
   * distinct from "we judged and it is fine" — substituting `ok` here would
   * paint a green line on an area nobody has an opinion about.
   */
  it('stores a check that reached no verdict as no level at all', () => {
    expect(checkResultRow('indexList', { ok: true, data: {}, measuredAt, verdict: null }))
      .toMatchObject({ ok: true, level: null, note: null });
  });
});


/**
 * The load row is the one piece of capture that is pure arithmetic, and the
 * cases that matter are the ones a live database will not stage on demand: a
 * `pg_stat_statements_reset()` landing between two captures, and the very
 * first capture of a database.
 *
 * What it must never do is write a zero. A zero on the load chart reads as
 * five idle minutes; a missing row reads as a gap. This project holds those
 * apart everywhere else, and a total summed over shapes is exactly where the
 * distinction is easiest to lose.
 */
describe('queryLoadRow', () => {
  const AT = new Date('2026-09-23T12:00:00Z');
  const EARLIER = new Date('2026-09-23T11:55:00Z');

  /** A cumulative snapshot, as `captureOnce` has just built it. */
  function snapshot(queryId: number, over: Partial<QueryStatsSnapshot> = {}): QueryStatsSnapshot {
    return {
      databaseId: 1, queryId, capturedAt: AT,
      calls: 100, totalExecTime: 1_000, rows: 500,
      sharedBlksHit: 900, sharedBlksRead: 100, statsReset: null,
      ...over,
    };
  }

  /** The same shape at the previous capture. */
  function before(over: Partial<CounterPoint> = {}): CounterPoint {
    return {
      capturedAt: EARLIER,
      calls: 40, totalExecTime: 250, rows: 200,
      sharedBlksHit: 400, sharedBlksRead: 50, statsReset: null,
      ...over,
    };
  }

  it('sums the interval across every shape', () => {
    const load = queryLoadRow(
      [snapshot(1), snapshot(2, { calls: 10, totalExecTime: 80 })],
      new Map([[1, before()], [2, before({ calls: 4, totalExecTime: 30 })]]),
    );
    // (100-40) + (10-4) calls; (1000-250) + (80-30) ms.
    expect(load).toEqual({ calls: 66, totalExecTime: 800 });
  });

  /**
   * A shape pgops had not seen at the previous capture has a counter
   * cumulative since ITS first sighting, which is a total of unknown age
   * rather than this interval's work.
   */
  it('ignores a shape with no previous reading', () => {
    const load = queryLoadRow(
      [snapshot(1), snapshot(2, { calls: 9_999, totalExecTime: 99_999 })],
      new Map([[1, before()]]),
    );
    expect(load).toEqual({ calls: 60, totalExecTime: 750 });
  });

  it('drops a shape whose interval spans a reset, and keeps the rest', () => {
    const load = queryLoadRow(
      // Shape 2's counters climbed PAST their old values after the reset, so
      // counter comparison alone would miss it — stats_reset is what catches
      // it, and charting that total would read as a five-minute spike.
      [snapshot(1), snapshot(2, { calls: 5_000, totalExecTime: 60_000, statsReset: AT })],
      new Map([[1, before()], [2, before({ calls: 4_900, totalExecTime: 59_000 })]]),
    );
    expect(load).toEqual({ calls: 60, totalExecTime: 750 });
  });

  /**
   * The mutation this catches: contributing a clamped zero instead of
   * nothing. A cluster-wide reset would then write `{calls: 0}` — a row
   * claiming the database did no work in an interval pgops could not
   * measure.
   */
  it('reports no row at all when nothing was measurable', () => {
    expect(queryLoadRow(
      [snapshot(1, { statsReset: AT }), snapshot(2, { statsReset: AT })],
      new Map([[1, before()], [2, before()]]),
    )).toBeNull();
  });

  it('reports no row for the first capture of a database', () => {
    expect(queryLoadRow([snapshot(1), snapshot(2)], new Map())).toBeNull();
  });
});
