import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { OWN_SQL_MARKER, ownSql, runCheck, runTool } from '../src/run.js';
import type { Check, CheckContext } from '../src/types.js';
import { sessions } from '../src/checks/sessions.js';
import { connections } from '../src/checks/connections.js';

/** A fake pool: only `query` is ever called by runCheck. */
function fakeCtx(impl: () => Promise<{ rows: unknown[] }>): CheckContext {
  return { target: { query: impl } as never, serverVersion: 170000 };
}

const doubler: Check<{ n: string }, number> = {
  id: 'doubler', home: 'database',
  title: 'Doubler',
  class: 'live',
  sql: 'SELECT 1 AS n',
  map: (rows) => Number(rows[0]?.n ?? 0) * 2,
};

describe('ownSql', () => {
  // The marker is a suffix. PostgreSQL 18 excludes a leading comment from the
  // text pg_stat_statements stores, so a prefix would be gone and query-stats
  // would stop folding pgops's own rows.
  it('puts the marker at the end, on its own line', () => {
    expect(ownSql('SELECT 1')).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
  });

  it('never puts the marker at the front, where PG 18 would drop it', () => {
    expect(ownSql('SELECT 1').startsWith(OWN_SQL_MARKER)).toBe(false);
    expect(ownSql('SELECT 1').endsWith(OWN_SQL_MARKER)).toBe(true);
  });

  it("keeps the marker out of a statement's trailing line comment", () => {
    // Appending on the same line would put the marker inside the `--`
    // comment. Several of this package's SQL constants end on a `--` line.
    const marked = ownSql('SELECT 1 -- why this column');
    expect(marked.split('\n').at(-1)).toBe(OWN_SQL_MARKER);
  });
});

describe('runCheck', () => {
  it('ends every check statement with the pgops marker', async () => {
    // `(..._args: unknown[])`, not `()`: a 0-arg callback types
    // `mock.calls[0]` as the empty tuple, which cannot be indexed.
    const impl = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
    await runCheck(fakeCtx(impl), {
      id: 'x', title: 'x', home: 'database', class: 'live', sql: 'SELECT 1', map: () => ({}),
    } as never);
    expect(impl.mock.calls[0]?.[0]).toBe('SELECT 1\n/* pgops */');
  });

  it('marks a parameterised statement too, leaving its values alone', async () => {
    const impl = vi.fn(async (..._args: unknown[]) => ({ rows: [] }));
    await runCheck(fakeCtx(impl), {
      id: 'x', title: 'x', home: 'database', class: 'live',
      sql: (o: { n: number }) => ({ text: 'SELECT $1', values: [o.n] }), map: () => ({}),
    } as never, { n: 7 });
    expect(impl.mock.calls[0]?.[0]).toBe('SELECT $1\n/* pgops */');
    expect(impl.mock.calls[0]?.[1]).toEqual([7]);
  });

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
    // A real pg.Pool; nothing listens on port 1. On a dual-stack host the
    // driver raises an AggregateError, on a single-stack host a plain Error.
    // Either way the message must name ECONNREFUSED; the test below pins the
    // unwrap deterministically.
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
    // The shape a real dual-stack dial rejects with: an AggregateError whose
    // own `.message` is '' and whose `.errors` carry ECONNREFUSED for ::1 and
    // 127.0.0.1. Fabricated so the unwrap does not depend on the host's
    // network stack.
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
 * A check whose `Opts` is `void` takes two arguments; any other check
 * requires three, or `check.sql(undefined)` would dereference `undefined`.
 *
 * The body is never called; it exists to be typechecked. The proof is
 * `npm run typecheck:test`: if the overloads stop rejecting the two-argument
 * call, the `@ts-expect-error` becomes an unused directive and tsc fails.
 * Vitest strips types without checking them.
 */
describe('runCheck’s arity is part of its type (I1)', () => {
  it('rejects an options-bearing check called without its options, at compile time', () => {
    const neverCalled = async (ctx: CheckContext): Promise<void> => {
      // @ts-expect-error — sessions declares SessionOpts; omitting it must not compile.
      await runCheck(ctx, sessions);
      await runCheck(ctx, sessions, { limit: 10 });
      // A void-Opts check keeps its two-argument call.
      await runCheck(ctx, connections);
    };
    expect(typeof neverCalled).toBe('function');
  });
});

/**
 * When ROLLBACK fails after the check's own query failed, `queryWithTimeout`
 * must destroy the pooled connection, or the next check to draw it gets
 * "current transaction is aborted".
 *
 * An integration test cannot pin this: pg-pool evicts a really dead socket
 * whatever argument `release()` is given. A fake client whose `ROLLBACK`
 * rejects while the rest looks healthy isolates that argument.
 */
describe('queryWithTimeout: pool hygiene when ROLLBACK itself fails', () => {
  const timedCheck: Check<{ n: string }, number> = { ...doubler, timeoutMs: 100 };

  it('passes the rollback error to release(), so pg-pool destroys the connection', async () => {
    const releaseCalls: unknown[] = [];
    const fakeClient = {
      query: async (text: string) => {
        if (text.startsWith('ROLLBACK')) throw new Error('connection lost');
        if (text.startsWith('BEGIN') || text.startsWith('SET LOCAL')) return { rows: [] };
        throw new Error('query failed');
      },
      on: () => {},
      removeListener: () => {},
      release: (err?: unknown) => releaseCalls.push(err),
    };
    const ctx: CheckContext = { target: { connect: async () => fakeClient } as never, serverVersion: 170000 };

    const r = await runCheck(ctx, timedCheck);

    // The operator sees the check's own query error, not the rollback failure.
    expect(r).toMatchObject({ ok: false, reason: 'error', message: 'query failed' });
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toBeInstanceOf(Error);
    expect((releaseCalls[0] as Error).message).toBe('connection lost');
  });

  it('releases with no argument when ROLLBACK succeeds — the ordinary case stays a plain, reusable release', async () => {
    const releaseCalls: unknown[] = [];
    const fakeClient = {
      query: async (text: string) => {
        if (text.startsWith('ROLLBACK')) return { rows: [] };
        if (text.startsWith('BEGIN') || text.startsWith('SET LOCAL')) return { rows: [] };
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

/** Guard: catches a new check landing with a threshold that cannot say why it escalates or what to do about it. */
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

  it('returns the data in the envelope a check returns', async () => {
    const tool = { id: 't', title: 'T', run: async (_c: CheckContext, n: number) => n * 2 };
    const r = await runTool(ctx, tool, 21);
    expect(r).toMatchObject({ ok: true, data: 42 });
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
