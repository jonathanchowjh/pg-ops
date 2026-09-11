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
