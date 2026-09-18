import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { captureOnce } from '../src/capture.js';
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
