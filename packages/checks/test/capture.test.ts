import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureOnce, checkResultRow, queryLoadRow } from '../src/capture.js';
import type { CounterPoint } from '../src/series/query-stats.js';
import type { QueryStatsSnapshot } from '../src/store/write.js';
import type { CheckContext } from '../src/types.js';

/**
 * Task 8 found the marker missing in THREE places a hardcoded two-file list
 * could never have caught: `tools/suggested-indexes.ts` reused `queryStats`'s
 * own sql() outside `runCheck` (so `toQuery`'s automatic prefix never ran),
 * and `actions/kill.ts` / `actions/stats.ts` read or reset catalog state with
 * no marker at all. The list-based version of this test could not see files
 * it did not name, and could not have seen the next one either — the
 * exemption for "text that must stay unmarked" was a SENTENCE in a plan,
 * and a sentence cannot shadow a second call site in the same file.
 *
 * So this sweeps every `.ts` file under `src/` for a direct
 * `ctx.target.query(...)` call — the one way to run a statement in this
 * package without going through `runCheck`/`toQuery` — and requires each one
 * to be either provably marked or named on an explicit allowlist with a
 * reason a reader can check, instead of a claim a reader has to trust.
 */
describe('the pgops marker on every catalog read that bypasses runCheck', () => {
  const SRC = fileURLToPath(new URL('../src/', import.meta.url));

  function allSourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
      ? allSourceFiles(join(dir, e.name))
      : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
  }

  /**
   * Whole files exempted from "every ctx.target.query call must be marked",
   * each with the reason a reader (or this test) can check independently —
   * see the dedicated `it` below, which verifies `explain.ts`'s reason holds
   * rather than just asserting the exemption exists.
   *
   * `actions/analyze.ts` used to be here as a whole-file entry, on the
   * reasoning that its calls are BEGIN/SET LOCAL/ANALYZE/COMMIT/ROLLBACK —
   * true of those five, but the file also has ONE actual `ctx.target.query`
   * catalog read, `TABLES_SQL` (`pg_class`/`pg_namespace`, choosing which
   * tables to ANALYZE), that a whole-file grant silently covered too. That
   * miss survived a plain `grep 'ctx.target.query('` because the call is
   * `ctx.target.query<{ qualified: string }>(` — the generic type argument
   * sits between the method name and the paren, and a literal-paren search
   * skips straight past it. `TABLES_SQL` is marked now and enforced by the
   * general sweep below like any other catalog read; analyze.ts's five
   * remaining statements need no entry here at all, because they run
   * through `client.query` on a manually checked-out client, never through
   * `ctx.target.query` — see "analyze.ts's transaction control…" below,
   * which pins that split directly rather than re-widening the exemption
   * back out to the whole file.
   *
   * `run.ts` is NOT here either: it is handled separately below, because
   * its one `ctx.target.query` call is `runCheck`'s own — the mechanism
   * that ADDS the marker, not a bypass of it — and its argument is a
   * runtime-computed `text` variable that no textual match on the call
   * site could ever confirm is marked. That is checked against `toQuery`'s
   * source directly instead (see "runCheck's own call carries the marker
   * unconditionally").
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
      if (rel === 'run.ts') continue; // see "runCheck's own call…" below.
      const allowed = ALLOWLIST.find((a) => a.file === rel);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(callRe)) {
        if (allowed) continue; // whole file exempt — see the dedicated per-file checks below.
        const line = src.slice(0, m.index).split('\n').length;
        const after = src.slice(m.index + m[0].length);
        // `ownSql(...)` is the marked form, and the ONLY one. It is the one
        // function that attaches OWN_SQL_MARKER, so a call site can no longer
        // get the marker's POSITION wrong — which is the whole point of
        // requiring it: the position used to be interpolated at ten call
        // sites, and when PostgreSQL 18 turned out to drop a leading comment
        // from pg_stat_statements' stored text, all ten had to move. A bare
        // template literal is therefore a failure here now, even one that
        // interpolates the marker itself.
        if (after.startsWith('ownSql(')) continue;
        if (after.startsWith('`')) {
          problems.push(`${rel}:${line}: inline query text is not wrapped in ownSql(...)`);
          continue;
        }
        const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(after)?.[0];
        // Only an ALL_CAPS name follows this package's convention for a SQL
        // constant (QUERY_STATS_SQL, KILL_SQL, …) closely enough to look up
        // its definition with confidence. Anything else — no identifier at
        // all, or a lowercase/camelCase one — is a shape this sweep cannot
        // verify statically, and per the brief that must FAIL, not pass:
        // a test that is wrong about its own scope is worse than no test.
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
    // planStatements runs entirely on its own dedicated connection
    // (ctx.target.connect(), then client.query) so that it can be destroyed
    // afterwards rather than returned to the pool — see explain.ts's own
    // docblock. That means this file was NEVER actually in scope for the
    // sweep above; it is named on the allowlist anyway, prophylactically, so
    // a reader sees the reason written down instead of having to rediscover
    // it — and so that if a direct ctx.target.query call is ever added here,
    // this assertion breaks and forces that reader to re-examine it.
    const src = readFileSync(new URL('../src/tools/explain.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/ctx\.target\.query/);
  });

  it("analyze.ts's transaction control and ANALYZE itself run via client.query, not ctx.target.query", () => {
    // BEGIN, both SET LOCAL statements, ANALYZE ${qualified}, COMMIT and
    // ROLLBACK all run on `client` — checked out with ctx.target.connect()
    // — never through `ctx.target.query` directly, so none of them were
    // ever in the general sweep's domain to begin with; analyze.ts needs no
    // allowlist entry for them, whole-file or otherwise. That is the reason
    // TABLES_SQL — the file's one REAL ctx.target.query call, a pg_class/
    // pg_namespace catalog read — could be missed by a whole-file exemption
    // written for these five statements: a grant covering the file covers
    // any call in it, not just the ones the reason names. TABLES_SQL is
    // marked now and enforced by the general sweep above like any other
    // catalog read.
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
    // suggested-indexes.ts is the file Change 1 touched: its OWN sql() reuse
    // (a few lines above) now carries the marker, and this call must not.
    // Checked directly against the call site rather than trusted from prose,
    // because that prose is exactly what let the two calls get confused once.
    const src = readFileSync(new URL('../src/tools/suggested-indexes.ts', import.meta.url), 'utf8');
    // Non-greedy up to the first `);` (statement end), not the first `)` —
    // the argument itself contains a nested call (`plannable.map((r) => …)`)
    // whose own closing paren would otherwise truncate the match early.
    const call = /planStatements\(ctx,[\s\S]*?\)\s*;/.exec(src);
    expect(call, 'suggested-indexes.ts should still call planStatements(ctx, …)').not.toBeNull();
    expect(call![0]).not.toMatch(/ownSql|OWN_SQL_MARKER/);
  });

  it("runCheck's own call carries the marker unconditionally (toQuery)", () => {
    // The one ctx.target.query call this sweep skips by name (run.ts) is
    // exactly this function's return value. Its argument at the call site is
    // a runtime `text` variable, which no textual match on the CALL could
    // ever confirm — so the guarantee is pinned here, against the function
    // that actually builds it, instead.
    const src = readFileSync(new URL('../src/run.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/return \{ \.\.\.q, text: ownSql\(q\.text\) \};/);
  });
});

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

/**
 * A7. A duplicate index is a FINDING with no verdict — pgHero's dashboard
 * shows it, and the triage rollup said "Indexes OK" because nothing wrote
 * anything to roll up. The count has to reach the cache without a verdict
 * being invented for it: inventing one would make `duplicateIndexes` able to
 * worsen a database's overall level, which is a different and wrong claim.
 */
describe('checkResultRow — a check that finds things and judges nothing', () => {
  it('writes the count as the note, with no level', () => {
    const row = checkResultRow('duplicateIndexes', {
      ok: true, verdict: null, measuredAt: 0,
      data: { pairs: [{ name: 'a', table: 't', coveredBy: 'b', sizeBytes: 1 }], total: 1 },
    });
    expect(row.level).toBeNull();
    expect(row.note).toBe('1 duplicate index');
  });

  it('writes no note when the check found nothing', () => {
    const row = checkResultRow('duplicateIndexes', {
      ok: true, verdict: null, measuredAt: 0, data: { pairs: [], total: 0 },
    });
    expect(row.note).toBeNull();
  });

  /**
   * A verdict always wins. `found` is for checks that have none; a check
   * that judged has already said the more important thing.
   */
  it('prefers a verdict note over a count', () => {
    const row = checkResultRow('unusedIndexes', {
      ok: true, verdict: { level: 'warn', note: 'the verdict speaking' }, measuredAt: 0,
      data: { indexes: [], total: 3 },
    });
    expect(row.note).toBe('the verdict speaking');
  });

  it('writes nothing for a check that did not run', () => {
    const row = checkResultRow('duplicateIndexes', { ok: false, reason: 'privilege', message: 'denied' });
    expect(row.note).toBeNull();
    expect(row.message).toBe('denied');
  });
});
