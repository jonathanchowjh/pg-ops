import { describe, expect, it } from 'vitest';
import { runCheck } from '../src/run.js';
import {
  duplicateIndexes,
  indexUsage, missingIndexes,
  indexCaching, indexHitRate, indexList, invalidIndexes, lastStatsReset, unusedIndexes,
} from '../src/checks/indexes.js';
import { withPostgres, seed } from './harness.js';

/**
 * Waits until the server has actually PUBLISHED the index I/O, which is a
 * fixture precondition and not the thing under test.
 *
 * Measured, not guessed: after fifty primary-key lookups the view reads
 * NULL immediately, at +205ms, +710ms and +1717ms, and first returns a
 * ratio at +3221ms. Since PostgreSQL 15 a backend accumulates statistics
 * locally and flushes them to shared memory at transaction end only once
 * `PGSTAT_MIN_INTERVAL` has elapsed, so a pool spreading fifty queries
 * across four backends publishes nothing for seconds.
 *
 * A fixed sleep would either be flaky or slow; `pg_stat_force_next_flush()`
 * would be neither, but it does not exist before PostgreSQL 15 and the CI
 * matrix runs 14. So: poll, with a ceiling that fails loudly.
 */
async function awaitPublishedIndexIo(pool: import('pg').Pool): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT coalesce(sum(idx_blks_hit + idx_blks_read), 0)::text AS n FROM pg_statio_user_indexes',
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) {
      throw new Error('pg_statio_user_indexes never published any index I/O within 20s');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The same PGSTAT_MIN_INTERVAL wait as `awaitPublishedIndexIo`, but for
 * `pg_stat_user_tables.idx_scan`, which is what index_usage divides by.
 */
async function awaitPublishedIndexScans(pool: import('pg').Pool, qualified: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT coalesce(idx_scan, 0)::text AS n FROM pg_stat_user_tables
       WHERE schemaname || '.' || relname = $1`, [qualified],
    );
    if (Number(rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error(`no index scans published for ${qualified} within 20s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Waits until both scan counters for `qualified` have been published. */
async function awaitSeqAndIndexScans(pool: import('pg').Pool, qualified: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ idx: string; seq: string }>(
      `SELECT coalesce(idx_scan, 0)::text AS idx, coalesce(seq_scan, 0)::text AS seq
       FROM pg_stat_user_tables WHERE schemaname || '.' || relname = $1`, [qualified],
    );
    if (Number(rows[0]?.idx ?? 0) > 0 && Number(rows[0]?.seq ?? 0) >= 20) return;
    if (Date.now() > deadline) throw new Error(`scan counters not published for ${qualified} within 20s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Waits for `seq_scan` alone, for a table deliberately never index-scanned. */
async function awaitSeqScans(pool: import('pg').Pool, qualified: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ seq: string }>(
      `SELECT coalesce(seq_scan, 0)::text AS seq FROM pg_stat_user_tables
       WHERE schemaname || '.' || relname = $1`, [qualified],
    );
    if (Number(rows[0]?.seq ?? 0) >= 20) return;
    if (Date.now() > deadline) throw new Error(`seq scans not published for ${qualified} within 20s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('indexHitRate against a real server', () => {
  /**
   * The assertion no unit test can make: that Postgres really returns NULL
   * here rather than 0. `withPostgres` gives a fresh database, which has done
   * no index I/O — so the dangerous case arrives for free, and a future
   * Postgres that changes this view fails here instead of warning on every
   * new database in production.
   */
  it('reads a null rate on a database with no index I/O yet', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, indexHitRate);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).toBeNull();
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  it('reads a real percentage once there has been index I/O', async () => {
    await withPostgres(async (ctx, pool) => {
      // One statement per `seed` call, as that helper asks, so a failure
      // names the statement that caused it.
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 500) g');
      await seed(pool, 'ANALYZE t');

      // No `enable_seqscan = off`. Verified on 17.11 that the planner picks
      // `Index Scan using t_pkey` for this predicate unaided — and a `SET`
      // here would be theatre anyway, since it binds one pooled backend
      // while the loop below is spread across four.
      for (let i = 1; i <= 50; i += 1) await pool.query('SELECT * FROM t WHERE id = $1', [i]);
      await awaitPublishedIndexIo(pool);

      const result = await runCheck(ctx, indexHitRate);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.rate).not.toBeNull();
      expect(result.data.rate!).toBeGreaterThan(0);
      expect(result.data.rate!).toBeLessThanOrEqual(100);
    });
  });
});

describe('the index inventory', () => {
  it('lists an index with its definition and size, schema-qualified', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE SCHEMA other');
      await seed(pool, 'CREATE TABLE public.t (a int, b int)');
      await seed(pool, 'CREATE TABLE other.t (a int, b int)');
      await seed(pool, 'CREATE INDEX ix_pub ON public.t (a)');
      await seed(pool, 'CREATE INDEX ix_oth ON other.t (a)');

      const result = await runCheck(ctx, indexList, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      // Both schemas qualified, both distinguishable. An earlier draft
      // returned bare names here and two identically-labelled rows.
      expect(names).toContain('public.ix_pub');
      expect(names).toContain('other.ix_oth');
      const pub = result.data.indexes.find((i) => i.name === 'public.ix_pub')!;
      expect(pub.table).toBe('public.t');
      expect(pub.definition).toContain('CREATE INDEX');
      expect(pub.sizeBytes).toBeGreaterThan(0);
      expect(pub.primary).toBe(false);
    });
  });

  it('excludes catalog and toast relations', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, indexList, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.startsWith('pg_'))).toBe(false);
    });
  });

  it('carries the pre-LIMIT total when it truncates', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int, b int, c int)');
      await seed(pool, 'CREATE INDEX ix_a ON t (a)');
      await seed(pool, 'CREATE INDEX ix_b ON t (b)');
      await seed(pool, 'CREATE INDEX ix_c ON t (c)');

      const result = await runCheck(ctx, indexList, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes).toHaveLength(1);
      expect(result.data.total).toBeGreaterThanOrEqual(3);
      expect(result.data.truncated).toBe(true);
    });
  });

  it('reads a null per-index cache rate before any I/O', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int)');
      await seed(pool, 'CREATE INDEX ix_a ON t (a)');

      const result = await runCheck(ctx, indexCaching, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.indexes.find((i) => i.name.endsWith('ix_a'))!;
      expect(row.hitRate).toBeNull();
    });
  });

  /**
   * The bigint trap, pinned.
   *
   * `idx_blks_hit` and `idx_blks_read` are both bigint, and bigint / bigint
   * is INTEGER division in Postgres. Measured on 17.11 with 39,649 hits and
   * 1 read, the uncast expression returns exactly `0` where the true rate is
   * 0.99997477931904161412 — so every index on the page would have reported
   * a 0% cache hit rate while `indexHitRate` above it reported 99.99%.
   *
   * The null case alone cannot catch this: with no I/O both forms return
   * NULL and agree. Only a busy index separates them, which is why this test
   * pays for the fixture and the wait.
   */
  it('computes a real per-index rate, not the 0 integer division would give', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE big (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO big SELECT g, g FROM generate_series(1, 20000) g');
      await seed(pool, 'ANALYZE big');
      for (let i = 1; i <= 200; i += 1) await pool.query('SELECT v FROM big WHERE id = $1', [i]);
      await awaitPublishedIndexIo(pool);

      const result = await runCheck(ctx, indexCaching, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.indexes.find((i) => i.name === 'public.big_pkey')!;
      expect(row.hitRate).not.toBeNull();
      // Strictly greater than zero is the assertion that dies under integer
      // division, which floors this to 0.
      expect(row.hitRate!).toBeGreaterThan(0);
      expect(row.hitRate!).toBeLessThanOrEqual(100);
    });
  });

  it('reports a never-reset database as null, not as an epoch', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, lastStatsReset);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.statsReset).toBeNull();
      // §2.2: no verdict function means null, and no badge.
      expect(result.verdict).toBeNull();
    });
  });
});

describe('index findings', () => {
  it('finds an invalid index and ignores the valid ones', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int, b int)');
      await seed(pool, 'CREATE INDEX ix_good ON t (a)');
      await seed(pool, 'CREATE INDEX ix_bad ON t (b)');
      // A failed CREATE INDEX CONCURRENTLY is what leaves indisvalid = false;
      // forcing that is unreliable, so mark it directly. This is the one
      // catalog write in the suite and the container is a throwaway.
      await pool.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'ix_bad'::regclass");

      const result = await runCheck(ctx, invalidIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      expect(names.some((n) => n.endsWith('ix_bad'))).toBe(true);
      expect(names.some((n) => n.endsWith('ix_good'))).toBe(false);
      expect(result.verdict?.level).toBe('warn');
    });
  });

  /**
   * §5's rule, as a falsifiable test. Three invalid indexes, a cap of one:
   * the verdict must say three. Written against `rows.length` this fails,
   * which is the entire point — asserting only `level === 'warn'` would be
   * true either way.
   */
  it('reports every invalid index in the verdict when the list is capped', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int, b int, c int)');
      await seed(pool, 'CREATE INDEX ix_a ON t (a)');
      await seed(pool, 'CREATE INDEX ix_b ON t (b)');
      await seed(pool, 'CREATE INDEX ix_c ON t (c)');
      await pool.query(`
        UPDATE pg_index SET indisvalid = false
        WHERE indexrelid IN ('ix_a'::regclass, 'ix_b'::regclass, 'ix_c'::regclass)`);

      const result = await runCheck(ctx, invalidIndexes, { limit: 1 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes).toHaveLength(1);
      expect(result.data.total).toBe(3);
      expect(result.verdict?.note).toContain('3');
    });
  });

  it('ignores an invalid index in a toast schema, which cannot be reindexed by name', async () => {
    await withPostgres(async (ctx) => {
      const result = await runCheck(ctx, invalidIndexes, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.startsWith('pg_'))).toBe(false);
    });
  });

  it('ignores an unused index below the 10 MB floor', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (a int)');
      await seed(pool, 'CREATE INDEX ix_small ON t (a)');

      const result = await runCheck(ctx, unusedIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.indexes.some((i) => i.name.endsWith('ix_small'))).toBe(false);
      expect(result.verdict).toEqual({ level: 'ok' });
    });
  });

  /**
   * 600,000 rows, and the number is load-bearing.
   *
   * At 400,000 — which is what this test was first written with — the
   * primary-key index measures 8792 kB and does not clear the 10 MB floor,
   * so the test passed whether or not `indisprimary` was excluded. It
   * asserted nothing it claimed to. Measured on 17.11 at 600,000 rows:
   * `big_pkey` 13 MB, `big_u_key` 22 MB, `ix_big_unused` 13 MB — all three
   * over the floor, so the two exclusions are the only thing keeping the
   * constraint-backing indexes out of the list.
   *
   * The positive assertion matters as much as the negative ones: without it
   * a query returning no rows at all would satisfy every "is not present"
   * expectation in this test.
   */
  it('never recommends dropping a primary key or a unique constraint', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE big (id int PRIMARY KEY, u text UNIQUE, v int)');
      await seed(pool, 'INSERT INTO big SELECT g, g::text, g FROM generate_series(1, 600000) g');
      await seed(pool, 'CREATE INDEX ix_big_unused ON big (v)');

      const result = await runCheck(ctx, unusedIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const names = result.data.indexes.map((i) => i.name);
      // The plain, unscanned, over-the-floor index IS the finding.
      expect(names).toContain('public.ix_big_unused');
      // Its two constraint-backing siblings are larger and equally unscanned,
      // and must never be offered for dropping.
      expect(names.some((n) => n.includes('pkey'))).toBe(false);
      expect(names.some((n) => n.includes('_key'))).toBe(false);
      expect(result.verdict?.level).toBe('warn');
    });
  });
});

describe('duplicateIndexes', () => {
  /**
   * One statement per `seed` call, as that helper asks. The column names are
   * chosen to reproduce a specific defect: `c1` and `c11` have `indkey` "1"
   * and "11", and `'11' LIKE '1%'`, so any implementation comparing indkey
   * as TEXT reports an index on c1 as covered by an index on c11.
   */
  const FIXTURE = [
    `CREATE TABLE w (
       c1 int, c2 int, c3 int, c4 int, c5 int,
       c6 int, c7 int, c8 int, c9 int, c10 int, c11 int,
       d text
     )`,
    'CREATE INDEX ix_c1      ON w (c1)',
    'CREATE INDEX ix_c1_copy ON w (c1)',
    'CREATE INDEX ix_c1_c2   ON w (c1, c2)',
    'CREATE INDEX ix_c11     ON w (c11)',
    'CREATE INDEX ix_hash_c1 ON w USING hash (c1)',
    'CREATE INDEX ix_d_pat   ON w (d text_pattern_ops)',
    'CREATE INDEX ix_d_c1    ON w (d, c1)',
    // TWO expression indexes, and the second is what makes the third
    // defect reproducible at all: every expression index has `indkey` "0",
    // so admitting them lets {0} prefix-match {0,1} and `lower(d)` is
    // reported as covered by `upper(d), c1`. With only one such index in the
    // fixture no pair can form, and the guard is untestable.
    'CREATE INDEX ix_expr    ON w (lower(d))',
    'CREATE INDEX ix_expr2   ON w (upper(d), c1)',
    'CREATE INDEX ix_full_c3 ON w (c3)',
    'CREATE INDEX ix_part    ON w (c3, c4) WHERE c4 > 0',
    // The two halves of the unique asymmetry. ix_uniq_c5 IS covered by
    // ix_c5_c6 on keys alone, and must never be offered for dropping —
    // dropping it changes what the database accepts. ix_plain_c7 IS
    // redundant against a unique index, and must be offered.
    'CREATE UNIQUE INDEX ix_uniq_c5 ON w (c5)',
    'CREATE INDEX ix_c5_c6   ON w (c5, c6)',
    'CREATE UNIQUE INDEX ix_uniq_c7 ON w (c7)',
    'CREATE INDEX ix_plain_c7 ON w (c7)',
  ];
  const build = async (pool: import('pg').Pool) => {
    for (const sql of FIXTURE) await seed(pool, sql);
  };
  const pairsOf = (d: { pairs: { name: string; coveredBy: string }[] }) =>
    d.pairs.map((p) => `${p.name.split('.').pop()}<=${p.coveredBy.split('.').pop()}`).sort();

  it('reports a genuine prefix duplicate', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).toContain('ix_c1<=ix_c1_c2');
    });
  });

  it('reports byte-identical duplicates, exactly once', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const exact = pairsOf(r.data).filter((p) => p.includes('ix_c1_copy'));
      // Reported, and not twice in both directions.
      expect(exact).toHaveLength(1);
    });
  });

  it('does not confuse column 1 with column 11', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_c1<=ix_c11');
    });
  });

  it('does not treat a different access method as covering', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data).some((p) => p.includes('ix_hash_c1'))).toBe(false);
    });
  });

  it('does not treat a different opclass as covering', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_d_pat<=ix_d_c1');
    });
  });

  it('does not treat a partial index as covering a full one', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data)).not.toContain('ix_full_c3<=ix_part');
    });
  });

  /**
   * Never the candidate, always available as the coverer.
   *
   * A unique index is covered by any index whose keys start with its own —
   * but it exists to enforce a constraint, and dropping it changes what the
   * database ACCEPTS, which no amount of redundancy makes safe. The reverse
   * is not true: an ordinary index duplicating a unique one is genuinely
   * redundant, and suppressing that would hide a real finding.
   */
  it('never offers a unique index for dropping, but lets one cover others', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const pairs = pairsOf(r.data);
      expect(pairs.some((p) => p.startsWith('ix_uniq_c5<='))).toBe(false);
      expect(pairs).toContain('ix_plain_c7<=ix_uniq_c7');
    });
  });

  it('does not collide expression indexes with column indexes', async () => {
    await withPostgres(async (ctx, pool) => {
      await build(pool);
      const r = await runCheck(ctx, duplicateIndexes, {});
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(pairsOf(r.data).some((p) => p.includes('ix_expr'))).toBe(false);
    });
  });
});

describe('index usage', () => {
  /**
   * The §3 divergence, and the reason the type is `number | null`.
   *
   * pgHero emits the STRING 'Insufficient data' in the same column as a
   * numeric percentage, so that column is text-or-number. pgops returns null.
   *
   * The reason the null arises is not what an earlier draft's comment
   * claimed. It is not "a table nobody has scanned": `idx_scan` is NULL for a
   * table with NO INDEXES AT ALL, so the heavily seq-scanned, index-less
   * table — the one most obviously wanting an index — is exactly the row
   * that reads as unknown rather than 0%.
   */
  it('reports null — not 0% — for a scanned table that has no index at all', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE noidx (a int)');
      await seed(pool, 'INSERT INTO noidx SELECT g FROM generate_series(1, 100) g');
      await seed(pool, 'ANALYZE noidx');
      await pool.query('SELECT count(*) FROM noidx');
      await pool.query('SELECT count(*) FROM noidx');

      const result = await runCheck(ctx, indexUsage, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table.endsWith('noidx'))!;
      expect(row).toBeDefined();
      // The whole §3 divergence: null, never the string, never 0.
      expect(row.indexHitRate).toBeNull();
      expect(row.estimatedRows).toBeGreaterThan(0);
    });
  });

  it('reports a real percentage for a table with index scans', async () => {
    await withPostgres(async (ctx, pool) => {
      await seed(pool, 'CREATE TABLE t (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO t SELECT g, g FROM generate_series(1, 1000) g');
      await seed(pool, 'ANALYZE t');
      for (let i = 1; i <= 20; i += 1) await pool.query('SELECT * FROM t WHERE id = $1', [i]);
      await awaitPublishedIndexScans(pool, 'public.t');

      const result = await runCheck(ctx, indexUsage, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.data.tables.find((t) => t.table === 'public.t')!;
      expect(row.indexHitRate).not.toBeNull();
      expect(row.indexHitRate!).toBeGreaterThan(0);
    });
  });

  /**
   * The floor is the ONLY thing separating these two tables.
   *
   * Both get one index scan and twenty sequential scans, so both land at an
   * index hit rate near 5% — far under pgHero's 95 — and both clear
   * `idx_scan > 0`. They differ only in size: 50 rows against 20,000. An
   * earlier version of this test used a single 50-row table that had been
   * index-scanned once and never seq-scanned, so it sat at 100% and was
   * excluded by the RATIO; deleting the row floor entirely left the test
   * green, which is how that was found.
   *
   * The positive assertion is load-bearing for the same reason: without it, a
   * query returning nothing at all satisfies the exclusion.
   */
  it('applies pgHero row floor, so only a table big enough to act on is listed', async () => {
    await withPostgres(async (ctx, pool) => {
      for (const [name, rows] of [['small', 50], ['big', 20000]] as const) {
        await seed(pool, `CREATE TABLE ${name} (id int PRIMARY KEY, v int)`);
        await seed(pool, `INSERT INTO ${name} SELECT g, g FROM generate_series(1, ${rows}) g`);
        await seed(pool, `ANALYZE ${name}`);
        for (let i = 0; i < 20; i += 1) await pool.query(`SELECT count(*) FROM ${name}`);
        // One genuine index scan, on a dedicated client with seqscan off.
        // At 50 rows the planner seq-scans even a primary-key lookup —
        // verified on 17.11 — so without this `small` never clears
        // `idx_scan > 0` and is excluded for a reason unrelated to the floor
        // this test is about. RESET before release: the client goes back to a
        // shared pool, and the setting would otherwise outlive this loop.
        const client = await pool.connect();
        try {
          await client.query('SET enable_seqscan = off');
          await client.query(`SELECT v FROM ${name} WHERE id = 1`);
          await client.query('RESET enable_seqscan');
        } finally {
          client.release();
        }
      }
      // A third table, large enough to clear the floor and index-scanned
      // ONLY — so its hit rate is 100% and the 95% ratio filter is the sole
      // thing excluding it. Without this the ratio clause could be deleted
      // with every test still green.
      await seed(pool, 'CREATE TABLE well (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO well SELECT g, g FROM generate_series(1, 20000) g');
      await seed(pool, 'ANALYZE well');
      // Sixty, not five, and the number is measured. `ANALYZE` itself
      // increments `seq_scan` by one (verified on 17.11), so five index scans
      // give 100*5/6 = 83% — under the 95% filter, and the table would have
      // been listed for the wrong reason. Sixty gives 98.4%.
      for (let i = 1; i <= 60; i += 1) await pool.query('SELECT v FROM well WHERE id = $1', [i]);

      // A fourth: large, indexed, heavily seq-scanned, and NEVER index
      // scanned. Its ratio is 0% and it clears the row floor, so
      // `idx_scan > 0` is the only clause excluding it — pgHero's rule that
      // a table nothing has ever index-scanned is not evidence about the
      // index it has.
      await seed(pool, 'CREATE TABLE cold (id int PRIMARY KEY, v int)');
      await seed(pool, 'INSERT INTO cold SELECT g, g FROM generate_series(1, 20000) g');
      await seed(pool, 'ANALYZE cold');
      for (let i = 0; i < 20; i += 1) await pool.query('SELECT count(*) FROM cold WHERE v = -1');

      await awaitSeqScans(pool, 'public.cold');
      await awaitSeqAndIndexScans(pool, 'public.big');
      await awaitSeqAndIndexScans(pool, 'public.small');
      await awaitPublishedIndexScans(pool, 'public.well');

      const result = await runCheck(ctx, missingIndexes, {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const tables = result.data.tables.map((t) => t.table);
      expect(tables).toContain('public.big');
      // Excluded by the row floor.
      expect(tables).not.toContain('public.small');
      // Excluded by the 95% index-hit-rate filter.
      expect(tables).not.toContain('public.well');
      // Excluded by `idx_scan > 0`.
      expect(tables).not.toContain('public.cold');
      expect(result.verdict).toBeNull();
    });
  });
});
