import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import type { Check, CheckContext } from '../src/types.js';
import { sessions } from '../src/checks/sessions.js';
import { blocked } from '../src/checks/blocked.js';

/** A fake pool: only `query` is ever called by runCheck. */
function fakeCtx(impl: () => Promise<{ rows: unknown[] }>): CheckContext {
  return { target: { query: impl } as never, serverVersion: 170000 };
}

const doubler: Check<{ n: string }, number> = {
  id: 'doubler',
  title: 'Doubler',
  class: 'incident',
  sql: 'SELECT 1 AS n',
  map: (rows) => Number(rows[0]?.n ?? 0) * 2,
};

describe('runCheck', () => {
  it('returns the mapped data and the time the query started', async () => {
    const before = Date.now();
    const r = await runCheck(fakeCtx(async () => ({ rows: [{ n: '21' }] })), doubler);
    expect(r).toMatchObject({ ok: true, data: 42 });
    if (r.ok) expect(r.measuredAt).toBeGreaterThanOrEqual(before);
  });

  it('never rejects — a thrown driver error becomes ok:false', async () => {
    const r = await runCheck(
      fakeCtx(async () => { throw new Error('boom'); }),
      doubler,
    );
    expect(r).toMatchObject({ ok: false, reason: 'error', message: 'boom' });
  });

  it('classifies a missing extension as missing-extension, with a remedy', async () => {
    const r = await runCheck(
      fakeCtx(async () => {
        const e = new Error('relation "pg_stat_statements" does not exist') as Error & { code: string };
        e.code = '42P01';
        throw e;
      }),
      { ...doubler, requires: [{ kind: 'extension', name: 'pg_stat_statements' }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'missing-extension' });
    if (!r.ok) expect(r.remedy).toBe('CREATE EXTENSION pg_stat_statements;');
  });

  it('classifies insufficient privilege, with the GRANT as the remedy', async () => {
    const r = await runCheck(
      fakeCtx(async () => {
        const e = new Error('permission denied') as Error & { code: string };
        e.code = '42501';
        throw e;
      }),
      { ...doubler, requires: [{ kind: 'role', name: 'pg_read_all_stats' }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'privilege' });
    if (!r.ok) expect(r.remedy).toBe('GRANT pg_read_all_stats TO CURRENT_USER;');
  });

  it('refuses to run below the check’s minimum server version', async () => {
    const r = await runCheck(
      { ...fakeCtx(async () => ({ rows: [] })), serverVersion: 130000 },
      { ...doubler, requires: [{ kind: 'version', min: 140000 }] },
    );
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-version' });
  });

  it('never rejects on a real connection refusal against an unreachable server', async () => {
    // 'localhost' resolves dual-stack (::1 and 127.0.0.1) on most hosts; nothing
    // listens on port 1 on either. This is a real pg.Pool, not a hand-rolled fake.
    //
    // The assertion is content-based, not length-based, on purpose: on a dual-stack
    // host the driver raises a real AggregateError, and messageOf() unwraps it to a
    // sub-error message containing ECONNREFUSED; on a single-stack host (no ::1 —
    // common in minimal CI containers) there is only one candidate, so the driver
    // raises a plain Error whose own .message already contains ECONNREFUSED. Either
    // way the operator-facing message names the real failure. A length check would
    // pass even with the unwrap deleted, since String(anAggregateError) is the
    // non-empty string "AggregateError" — see the deterministic test below for the
    // assertion that actually pins the unwrap.
    const pool = new Pool({ host: 'localhost', port: 1, connectionTimeoutMillis: 500 });
    try {
      const r = await runCheck({ target: pool, serverVersion: 170000 }, doubler);
      expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
      if (!r.ok) expect(r.message).toContain('ECONNREFUSED');
    } finally {
      await pool.end();
    }
  });

  it('unwraps a dual-stack AggregateError instead of reporting its own empty/generic message', async () => {
    // Pinned from a real dial (see the test above, run on a dual-stack host):
    // `new Pool({ host: 'localhost', port: 1 }).query(...)` rejects with an
    // AggregateError whose own `.message` is '' and whose `.errors` are plain
    // Errors carrying ECONNREFUSED for ::1 and 127.0.0.1. This test fabricates
    // that exact measured shape so the unwrap branch has deterministic coverage
    // that does not depend on this host's network stack or CI's IPv6 support.
    const aggregate = Object.assign(
      new AggregateError(
        [
          Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
        ],
        '',
      ),
      { code: 'ECONNREFUSED' },
    );

    const r = await runCheck(fakeCtx(async () => { throw aggregate; }), doubler);

    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
    if (!r.ok) {
      expect(r.message).toContain('ECONNREFUSED');
      expect(r.message).not.toBe('AggregateError');
    }
  });
});

/**
 * I1 (final review). `runCheck`'s third parameter used to carry
 * `= undefined as Opts`, and a parameter with a default is optional — so
 * `runCheck(ctx, sessions)` compiled, `check.sql(undefined)` then
 * dereferenced `undefined`, and because `runCheck` never rejects the
 * TypeError surfaced as an ordinary failed check ("Cannot read properties
 * of undefined (reading 'limit')") on the page an operator was reading
 * during an incident. Two overloads now separate the two cases: a check
 * whose `Opts` is `void` takes two arguments, any other check requires
 * three.
 *
 * This body is never CALLED — it exists to be typechecked. The proof is
 * `npm run typecheck:test`: if the overloads stop rejecting the two-argument
 * call, the `@ts-expect-error` below becomes an unused directive and tsc
 * fails on that line itself. A test that only ran under vitest would prove
 * nothing here, since vitest strips types without checking them.
 */
describe('runCheck’s arity is part of its type (I1)', () => {
  it('rejects an options-bearing check called without its options, at compile time', () => {
    const neverCalled = async (ctx: CheckContext): Promise<void> => {
      // @ts-expect-error — sessions declares SessionOpts; omitting it must not compile.
      await runCheck(ctx, sessions);
      // ...and supplying them still does.
      await runCheck(ctx, sessions, { limit: 10 });
      // A void-Opts check keeps its two-argument call — the overload split
      // must not force a meaningless third argument on every other check.
      await runCheck(ctx, blocked);
    };
    expect(typeof neverCalled).toBe('function');
  });
});
