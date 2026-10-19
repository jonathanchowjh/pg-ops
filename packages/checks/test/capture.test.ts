import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureOnce, queryLoadRow } from '../src/capture.js';
import type { CounterPoint } from '../src/series/query-stats.js';
import type { QueryStatsSnapshot } from '../src/store/write.js';
import type { CheckContext } from '../src/types.js';

/**
 * Catches a statement sent without the pgops marker. Sweeps every `.ts` file
 * under `src/` for a direct `ctx.target.query(...)` call — the one way to run
 * a statement without going through `runCheck`/`toQuery` — and requires each
 * to be provably marked or allowlisted with a checkable reason.
 */
describe('the pgops marker on every catalog read that bypasses runCheck', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));

  function allSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? allSourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  }

  /**
   * Whole files exempt from the sweep. A whole-file entry covers every call
   * in the file, not just the ones its reason names, so keep this short:
   * `actions/analyze.ts` and `run.ts` are deliberately not here and have
   * their own tests below.
   */
  const ALLOWLIST: ReadonlyArray<{ file: string; reason: string }> = [
    {
      file: 'tools/explain.ts',
      reason: 'planStatements runs EXPLAIN over an OPERATOR-supplied statement — the text is '
        + 'theirs, not pgops\'s, and marking it would misattribute their SQL and change what '
        + 'Postgres plans.',
    },
  ];

  it('marks every direct ctx.target.query call that is not explicitly allowlisted', () => {
    const problems: string[] = [];
    const callRe = /ctx\.target\.query(?:<[\s\S]*?>)?\s*\(\s*/g;

    for (const file of allSourceFiles(SRC)) {
      const rel = relative(SRC, file).split(sep).join('/');
      if (rel === 'run.ts') continue; // see "runCheck's own call…" below
      const allowed = ALLOWLIST.find((a) => a.file === rel);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(callRe)) {
        if (allowed) continue; // whole file exempt
        const line = src.slice(0, m.index).split('\n').length;
        const after = src.slice(m.index + m[0].length);
        // `ownSql(...)` is the only marked form: it alone decides where the
        // marker goes (PostgreSQL 18 drops a leading comment from
        // pg_stat_statements' stored text). A bare template literal fails,
        // even one that interpolates the marker itself.
        if (after.startsWith('ownSql(')) continue;
        if (after.startsWith('`')) {
          problems.push(`${rel}:${line}: inline query text is not wrapped in ownSql(...)`);
          continue;
        }
        const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(after)?.[0];
        // Only an ALL_CAPS name (QUERY_STATS_SQL, KILL_SQL, …) can be looked
        // up with confidence. Any other argument shape cannot be verified
        // statically, so it fails rather than passes.
        if (!id || !/^[A-Z][A-Z0-9_]*$/.test(id)) {
          problems.push(`${rel}:${line}: this call's argument (${id ?? 'unrecognized'}) is not an `
            + 'ALL_CAPS SQL constant or inline template this sweep can verify statically — name it '
            + 'that way, or add the file/line to the allowlist with a reason.');
          continue;
        }
        if (!new RegExp(`const\\s+${id}\\b[^=]*=\\s*ownSql\\(`).test(src)) {
          problems.push(`${rel}:${line}: ${id} is not defined as ownSql(\`…\`)`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('explain.ts is allowlisted for a reason this test can check: it never calls ctx.target.query at all', () => {
    // planStatements runs on its own connection (ctx.target.connect(), then
    // client.query). If a direct ctx.target.query call is ever added to
    // explain.ts, this fails and the allowlist entry must be re-examined.
    const src = readFileSync(new URL('../src/tools/explain.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ctx\.target\.query/);
  });

  it("analyze.ts's transaction control and ANALYZE itself run via client.query, not ctx.target.query", () => {
    // These run on a checked-out `client`, outside the sweep's domain, so
    // they are pinned here. TABLES_SQL is the file's one ctx.target.query
    // call and is covered by the sweep; the generic type argument sits
    // between `query` and the paren, so a literal `query(` search misses it.
    const src = readFileSync(new URL('../src/actions/analyze.ts', import.meta.url), 'utf8');
    for (const stmt of [
      "client.query(ownSql('BEGIN'))",
      'client.query(ownSql(`SET LOCAL lock_timeout = ${lockMs}`))',
      'client.query(ownSql(`SET LOCAL statement_timeout = ${stmtMs}`))',
      'client.query(ownSql(`ANALYZE ${qualified}`))',
      "client.query(ownSql('COMMIT'))",
      "client.query(ownSql('ROLLBACK'))",
    ]) {
      expect(src, stmt).toContain(stmt);
    }
    expect(src).toMatch(/ctx\.target\.query<\{ qualified: string }>\(\s*\n\s*TABLES_SQL/);
  });

  it('never marks the operator statement planStatements sends to EXPLAIN', () => {
    // suggested-indexes.ts marks its own sql() reuse; the operator's
    // statement passed to planStatements must stay unmarked.
    const src = readFileSync(new URL('../src/tools/suggested-indexes.ts', import.meta.url), 'utf8');
    // Up to the first `);`, not the first `)`: the argument contains a
    // nested call.
    const call = /planStatements\(ctx,[\s\S]*?\)\s*;/.exec(src);
    expect(call, 'suggested-indexes.ts should still call planStatements(ctx, …)').not.toBeNull();
    expect(call![0]).not.toMatch(/ownSql|OWN_SQL_MARKER/);
  });

  it("runCheck's own call carries the marker unconditionally (toQuery)", () => {
    // run.ts's call passes a runtime `text` variable the sweep cannot verify
    // at the call site, so the marker is pinned on the function that builds it.
    const src = readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/return \{ \.\.\.q, text: ownSql\(q\.text\) \};/);
  });
});

/**
 * Node raises an AggregateError with an empty `.message` when a host resolves
 * to several addresses and every connect attempt fails — what
 * `PGOPS_STORE_URL=postgres://localhost/pgops` produces when nothing is
 * listening. Reading `err.message` alone reports the failure with no reason.
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
 * A real EventEmitter, because the hazard is its contract: an 'error' event
 * with no listener is fatal to the process, and pg-pool removes the client's
 * own listener while the client is checked out.
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
   * capture.ts holds one store client across both scans and the write
   * transaction. pg emits 'error' on the client when the connection dies,
   * from a socket callback outside any try/catch of ours, so an unguarded
   * client exits the web process.
   *
   * `setImmediate` is load-bearing: emitting inline would land the throw
   * inside captureOnce's own try/catch and pass against the unguarded version.
   */
  it('does not take the process down when the connection drops mid-capture', async () => {
    const client = new FakeStoreClient();
    const target = {
      query: async (text: string) => {
        if (text.includes('pg_stat_statements')) {
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

    // What matters is that no unhandled 'error' escaped.
    await expect(captureOnce(ctx, 'app')).resolves.toBeDefined();
    // The listener came off again, so a reused connection cannot accumulate
    // one per capture.
    expect(client.listenerCount('error')).toBe(0);
    expect(client.released).toBe(1);
  });
});

/** A monitored database whose catalog reads answer `tables`, or fail it. */
function catalogTarget(tables: { name: string; size: number }[] | 'fails') {
  const row = (t: { name: string; size: number }) => ({
    name: t.name, kind: 'table', size_bytes: String(t.size), heap_bytes: '0', index_bytes: '0', live_rows: '0',
    dead_rows: '0', vacuum_trigger: '50', inserted: '0', updated: '0', deleted: '0', seq_scans: '0', seq_rows: '0',
    idx_scans: null, idx_rows: null, hit_rate: null, last_vacuum_ms: null, last_analyze_ms: null, xid_age: 1,
    indexes: 0, unvalidated: 0, vacuuming: null, freeze_max_age: 2e8, stats_reset_ms: null, total: tables.length,
  });
  const client = Object.assign(new EventEmitter(), {
    release: () => {},
    query: async (text: string) => {
      if (!text.includes('pg_total_relation_size')) return { rows: [] };
      if (tables === 'fails') throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      return { rows: tables.map(row) };
    },
  });
  return { query: async () => ({ rows: [] }), connect: async () => client };
}

/** The space rows one capture writes, as [relation, bytes]. */
async function spaceWritten(target: unknown): Promise<[unknown, unknown][]> {
  const client = new FakeStoreClient();
  const values: unknown[] = [];
  const query = client.query.bind(client);
  client.query = async (text: string, v?: unknown[]) => {
    if (text.includes('INSERT INTO pgops.space_stats')) values.push(...(v ?? []));
    return query(text);
  };
  const outcome = await captureOnce({ target, store: { connect: async () => client }, serverVersion: 170000 } as unknown as CheckContext, 'app');
  expect(outcome).toMatchObject({ ok: true });
  const rows: [unknown, unknown][] = [];
  // database_id, relation, captured_at, size_bytes
  for (let i = 0; i < values.length; i += 4) rows.push([values[i + 1], values[i + 3]]);
  return rows;
}

/**
 * The space series is the `tables` read's sizes: one size scan of each
 * relation a pass, under that read's timeouts, where a second scan of its
 * own had none and a migration's lock could hold the capture for hours.
 */
describe('captureOnce and the space series', () => {
  it('writes the tables read\'s own sizes', async () => {
    const rows = await spaceWritten(catalogTarget([{ name: 'public.big', size: 81_920 }, { name: 'public.empty', size: 0 }]));
    // An empty table measures 0 bytes, which is a real measurement.
    expect(rows).toEqual([['public.big', 81_920], ['public.empty', 0]]);
  });

  it('writes no size, never a zero, when the tables read failed', async () => {
    expect(await spaceWritten(catalogTarget('fails'))).toEqual([]);
  });
});

describe('captureOnce and statement text', () => {
  /** redactSecrets masks a quoted value only to its line's end, so the rest of a split literal would be stored. */
  it('redacts a statement on one line, so a secret on its second line is masked too', async () => {
    const client = new FakeStoreClient();
    const stored: unknown[] = [];
    const query = client.query.bind(client);
    client.query = async (text: string, v?: unknown[]) => {
      if (text.includes('INSERT INTO pgops.queries')) stored.push(...((v?.[2] as unknown[]) ?? []));
      return query(text);
    };
    const target = {
      ...catalogTarget([]),
      query: async (text: string) => (text.includes('pg_stat_statements')
        ? { rows: [{ queryid: '7', query: "SELECT id FROM t /* api_key: 'abcd\nhunter2' */", calls: '1', total_exec_time: 1, rows: '1', shared_blks_hit: '0', shared_blks_read: '0', stats_reset: null }] }
        : { rows: [] }),
    };
    await captureOnce({ target, store: { connect: async () => client }, serverVersion: 170000 } as unknown as CheckContext, 'app');
    expect(stored).toEqual(['SELECT id FROM t /* api_key: *** */']);
  });
  it('stores the shape: a line comment is dropped, not left to swallow the statement\'s tail', async () => {
    const client = new FakeStoreClient();
    const stored: unknown[] = [];
    const query = client.query.bind(client);
    client.query = async (text: string, v?: unknown[]) => {
      if (text.includes('INSERT INTO pgops.queries')) stored.push(...((v?.[2] as unknown[]) ?? []));
      return query(text);
    };
    const target = {
      ...catalogTarget([]),
      query: async (text: string) => (text.includes('pg_stat_statements')
        ? { rows: [{ queryid: '7', query: "SELECT id -- the key\nFROM t\nWHERE id = $1 AND kind = 'x'", calls: '1', total_exec_time: 1, rows: '1', shared_blks_hit: '0', shared_blks_read: '0', stats_reset: null }] }
        : { rows: [] }),
    };
    await captureOnce({ target, store: { connect: async () => client }, serverVersion: 170000 } as unknown as CheckContext, 'app');
    expect(stored).toEqual(['SELECT id FROM t WHERE id = $1 AND kind = $2']);
  });
});

/**
 * Covers the cases a live database will not stage on demand: a
 * `pg_stat_statements_reset()` between two captures, and the first capture.
 * The load row must never be a zero: a zero reads as idle minutes, a missing
 * row as a gap.
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

  /** A new shape's counter is cumulative since its first sighting, not this interval's work. */
  it('ignores a shape with no previous reading', () => {
    const load = queryLoadRow(
      [snapshot(1), snapshot(2, { calls: 9_999, totalExecTime: 99_999 })],
      new Map([[1, before()]]),
    );
    expect(load).toEqual({ calls: 60, totalExecTime: 750 });
  });

  it('drops a shape whose interval spans a reset, and keeps the rest', () => {
    const load = queryLoadRow(
      // Shape 2's counters climbed past their old values after the reset, so
      // only stats_reset catches it.
      [snapshot(1), snapshot(2, { calls: 5_000, totalExecTime: 60_000, statsReset: AT })],
      new Map([[1, before()], [2, before({ calls: 4_900, totalExecTime: 59_000 })]]),
    );
    expect(load).toEqual({ calls: 60, totalExecTime: 750 });
  });

  /** Catches a clamped zero: a cluster-wide reset must not write `{calls: 0}`. */
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
