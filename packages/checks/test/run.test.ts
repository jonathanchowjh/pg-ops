import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { runCheck, runTool } from '../src/run.js';
import type { Check, CheckContext } from '../src/types.js';
import { sessions } from '../src/checks/sessions.js';
import { blocked } from '../src/checks/blocked.js';

/** A fake pool: only `query` is ever called by runCheck. */
function fakeCtx(impl: () => Promise<{ rows: unknown[] }>): CheckContext {
  return { target: { query: impl } as never, serverVersion: 170000 };
}

const doubler: Check<{ n: string }, number> = {
  id: 'doubler', gate: 'work',
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

/**
 * `queryWithTimeout` (internal to run.ts, exercised here only through
 * `runCheck` + `timeoutMs`) must destroy a pooled connection rather than
 * return it to the pool as healthy when ROLLBACK itself fails after the
 * check's own query already failed — otherwise the next check to draw that
 * connection gets "current transaction is aborted, commands ignored until
 * end of transaction block", the exact poisoned-pooled-connection failure
 * this function exists to prevent.
 *
 * A real `pg_terminate_backend`-against-a-live-connection integration test
 * (timeout.int.test.ts) cannot pin this specifically: once a connection's
 * socket actually dies, node-postgres's own Client sets `_queryable =
 * false`, and pg-pool's `_release` checks that flag independently of
 * whatever argument our code passes to `release()` — so a real dead socket
 * gets evicted from the pool either way, fixed code or not. A fake client
 * whose `ROLLBACK` rejects while everything else about it looks healthy is
 * what isolates the one thing this fix actually controls: the argument
 * `release()` is called with.
 */
describe('queryWithTimeout: pool hygiene when ROLLBACK itself fails', () => {
  const timedCheck: Check<{ n: string }, number> = { ...doubler, timeoutMs: 100 };

  it('passes the rollback error to release(), so pg-pool destroys the connection', async () => {
    const releaseCalls: unknown[] = [];
    const fakeClient = {
      query: async (text: string) => {
        if (text === 'ROLLBACK') throw new Error('connection lost');
        if (text === 'BEGIN' || text.startsWith('SET LOCAL')) return { rows: [] };
        throw new Error('query failed');
      },
      on: () => {},
      removeListener: () => {},
      release: (err?: unknown) => releaseCalls.push(err),
    };
    const ctx: CheckContext = { target: { connect: async () => fakeClient } as never, serverVersion: 170000 };

    const r = await runCheck(ctx, timedCheck);

    // The check's own query error is what the operator sees — a rollback
    // failure on top of it must never replace or hide that message.
    expect(r).toMatchObject({ ok: false, reason: 'error', message: 'query failed' });
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toBeInstanceOf(Error);
    expect((releaseCalls[0] as Error).message).toBe('connection lost');
  });

  it('releases with no argument when ROLLBACK succeeds — the ordinary case stays a plain, reusable release', async () => {
    const releaseCalls: unknown[] = [];
    const fakeClient = {
      query: async (text: string) => {
        if (text === 'ROLLBACK') return { rows: [] };
        if (text === 'BEGIN' || text.startsWith('SET LOCAL')) return { rows: [] };
        throw new Error('query failed');
      },
      on: () => {},
      removeListener: () => {},
      release: (err?: unknown) => releaseCalls.push(err),
    };
    const ctx: CheckContext = { target: { connect: async () => fakeClient } as never, serverVersion: 170000 };

    const r = await runCheck(ctx, timedCheck);

    expect(r).toMatchObject({ ok: false, reason: 'error', message: 'query failed' });
    expect(releaseCalls).toEqual([undefined]);
  });
});

/**
 * `crossed` — the threshold a verdict actually crossed, resolved once here so
 * every surface can explain itself without asking.
 *
 * `Threshold.because` is required and non-empty by contract, and reached no
 * pixel of the console: the UI showed a red badge and a number and never said
 * why the number was bad. Resolving it at each of the nine call sites that
 * render a panel would have made "forgot to explain this one" a thing a page
 * written later could do.
 */
describe('runCheck resolves the threshold a verdict crossed', () => {
  const graded: Check<{ n: string }, number> = {
    id: 'graded', gate: 'work',
    title: 'Graded',
    class: 'incident',
    sql: 'SELECT 1 AS n',
    map: (rows) => Number(rows[0]?.n ?? 0),
    thresholds: [
      { level: 'warn', value: 10, unit: 'count', because: 'ten is worth a look', remedy: 'Look at it.' },
      { level: 'critical', value: 20, unit: 'count', because: 'twenty is an incident' },
    ],
    verdict: (d) => ({ level: d >= 20 ? 'critical' : d >= 10 ? 'warn' : 'ok' }),
  };

  const run = (n: string) => runCheck(fakeCtx(async () => ({ rows: [{ n }] })), graded);

  it('hands back the threshold matching the verdict level, with its remedy', async () => {
    const r = await run('12');
    expect(r).toMatchObject({ ok: true, crossed: { because: 'ten is worth a look', remedy: 'Look at it.' } });
  });

  it('picks the critical threshold, not merely the first one that exists', async () => {
    const r = await run('25');
    if (!r.ok) throw new Error('expected ok');
    // The bug this pins: `thresholds[0]` would pass the warn case above and
    // then explain a CRITICAL connection pool with the warn sentence — the
    // more alarming badge next to the calmer reason.
    expect(r.crossed?.because).toBe('twenty is an incident');
  });

  /**
   * `ok` crossed nothing, so there is nothing to explain. Resolving a
   * threshold here would attach a critical rationale to a healthy reading —
   * the same "we looked and it is fine" over-claim as substituting an `ok`
   * verdict for a check that has no opinion.
   */
  it('resolves nothing for a healthy reading', async () => {
    const r = await run('3');
    if (!r.ok) throw new Error('expected ok');
    // Asserted directly, not via toMatchObject: an expected `undefined` there
    // is satisfied by an absent key AND by a present one, so the version of
    // this test written that way survived a mutation that resolved the WARN
    // threshold for a healthy reading — it would have explained a green
    // panel with the sentence justifying an escalation.
    expect(r.crossed).toBeUndefined();
  });

  it('resolves nothing for a check that does not judge', async () => {
    const r = await runCheck(fakeCtx(async () => ({ rows: [{ n: '99' }] })), doubler);
    if (!r.ok) throw new Error('expected ok');
    expect(r.verdict).toBeNull();
    expect(r.crossed).toBeUndefined();
  });
});

/**
 * Every threshold that escalates should be able to say what to do about it.
 *
 * Not a style rule: `because` is enforced non-empty for the same reason, and
 * the pair is what turns a red badge into something an operator woken at 3am
 * can act on. A new check landing without one is the failure mode this
 * catches — the sentence is easy to leave for later and later never comes.
 */
describe('every shipped threshold carries advice', () => {
  it('has a non-empty because and remedy on every threshold in CHECKS', async () => {
    const { CHECKS } = await import('../src/registry.js');
    const missing: string[] = [];
    for (const [id, check] of Object.entries(CHECKS)) {
      for (const t of check.thresholds ?? []) {
        if (!t.because?.trim()) missing.push(`${id}/${t.level}: because`);
        if (!t.remedy?.trim()) missing.push(`${id}/${t.level}: remedy`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('runTool', () => {
  const ctx: CheckContext = { target: {} as never, serverVersion: 170000 };

  it('returns the data with verdict null — a tool answers, it never judges', async () => {
    const tool = { id: 't', title: 'T', run: async (_c: CheckContext, n: number) => n * 2 };
    const r = await runTool(ctx, tool, 21);
    expect(r).toMatchObject({ ok: true, data: 42, verdict: null });
  });

  it('refuses below its version floor without running', async () => {
    let ran = false;
    const tool = {
      id: 't', title: 'T', requires: [{ kind: 'version' as const, min: 180000 }],
      run: async () => { ran = true; },
    };
    const r = await runTool(ctx, tool, undefined);
    expect(r).toMatchObject({ ok: false, reason: 'unsupported-version' });
    expect(ran).toBe(false);
  });

  it('classifies a missing extension and hands back the remedy', async () => {
    const tool = {
      id: 't', title: 'T', requires: [{ kind: 'extension' as const, name: 'pg_stat_statements' }],
      run: async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); },
    };
    const r = await runTool(ctx, tool, undefined);
    expect(r).toEqual({
      ok: false, reason: 'missing-extension', message: 'relation does not exist',
      remedy: 'CREATE EXTENSION pg_stat_statements;',
    });
  });

  it('never rejects, even on a thrown non-Error', async () => {
    const tool = { id: 't', title: 'T', run: async () => { throw 'boom'; } };
    await expect(runTool(ctx, tool, undefined))
      .resolves.toMatchObject({ ok: false, reason: 'error', message: 'boom' });
  });
});
