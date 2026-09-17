import { describe, expect, it } from 'vitest';
import {
  indexCaching, indexHitRate, indexList, invalidIndexes, lastStatsReset, unusedIndexes,
  duplicateIndexes, indexUsage, missingIndexes,
  toTableUsage,
  toDuplicates, toFindings, toIndexCaching, toIndexList, toRate, toStatsReset,
} from '../src/checks/indexes.js';

describe('toRate', () => {
  it('keeps a NULL rate as null rather than collapsing it to zero', () => {
    expect(toRate([{ rate: null }])).toEqual({ rate: null });
  });

  it('returns null for an empty view rather than inventing a reading', () => {
    expect(toRate([])).toEqual({ rate: null });
  });

  /**
   * Rounded to two decimals in `map`, not at the edge. The obvious
   * implementation returns `Number(raw) * 100` raw, and `Number('0.9912') *
   * 100` is 99.11999999999999 — so the obvious test fails. Postgres makes it
   * worse: numeric division returns 20 decimal places, e.g.
   * 0.99193548387096774194. Rounding here means one representation
   * everywhere, including anything a later phase stores.
   */
  it('rounds to two decimals so the value is exactly what is displayed', () => {
    expect(toRate([{ rate: '0.9912' }])).toEqual({ rate: 99.12 });
    expect(toRate([{ rate: '0.99193548387096774194' }])).toEqual({ rate: 99.19 });
  });

  it('keeps a genuine zero, which is not the same as unknown', () => {
    expect(toRate([{ rate: '0' }])).toEqual({ rate: 0 });
  });
});

describe('indexHitRate verdict', () => {
  const t = () => indexHitRate.thresholds!;

  /**
   * `Verdict.level` is `ok | warn | critical` and `verdict` must return one,
   * so "we could not measure" has no representation of its own here — the
   * same shape slots.ts uses when `retainedBytes` is null. What matters is
   * that an unknown rate does not ESCALATE; the `ok` is the absence of a
   * finding, not a claim that the cache is healthy.
   */
  it('does not escalate when the rate is unknown', () => {
    expect(indexHitRate.verdict!({ rate: null }, t())).toEqual({ level: 'ok' });
  });

  // §9 boundary rule: at the value, and one unit either side.
  it('is ok exactly at 99', () => {
    expect(indexHitRate.verdict!({ rate: 99 }, t()).level).toBe('ok');
  });

  it('warns just below 99', () => {
    expect(indexHitRate.verdict!({ rate: 98.99 }, t()).level).toBe('warn');
  });

  it('is ok just above 99', () => {
    expect(indexHitRate.verdict!({ rate: 99.01 }, t()).level).toBe('ok');
  });

  it('names the reading in the note, so the badge says what it saw', () => {
    expect(indexHitRate.verdict!({ rate: 98 }, t()).note).toContain('98');
  });
});

describe('toIndexList', () => {
  const row = {
    name: 'public.ix_a', table_name: 'public.t', definition: 'CREATE INDEX ix_a ON public.t USING btree (a)',
    size_bytes: '8192', is_unique: false, is_primary: false, total: 1,
  };

  it('converts a bigint size out of text', () => {
    // Convention 1: int8 arrives as a string. A 4 GB index is 4294967296,
    // which is past 2^31 and would be wrong if anything treated it as int4.
    expect(toIndexList([{ ...row, size_bytes: '4294967296' }]).indexes[0]!.sizeBytes).toBe(4294967296);
  });

  /**
   * The §5 rule, and the reason `total` is selected at all. `rows.length` is
   * the post-LIMIT count, so a truncated list reading `rows.length` reports
   * itself complete — and the operator never learns there are ninety more
   * indexes than the page shows.
   */
  it('takes truncated from the pre-LIMIT total, not from the rows returned', () => {
    const d = toIndexList([{ ...row, total: 37 }]);
    expect(d.total).toBe(37);
    expect(d.truncated).toBe(true);
  });

  it('is not truncated when the total equals the rows returned', () => {
    expect(toIndexList([{ ...row, total: 1 }]).truncated).toBe(false);
  });

  it('reports an empty database as empty rather than throwing', () => {
    expect(toIndexList([])).toEqual({ indexes: [], total: 0, truncated: false });
  });

  it('renames the reserved-word columns into the domain shape', () => {
    const e = toIndexList([{ ...row, is_unique: true, is_primary: true }]).indexes[0]!;
    expect(e).toMatchObject({ table: 'public.t', unique: true, primary: true });
  });
});

describe('toIndexCaching', () => {
  const row = { name: 'public.ix_a', table_name: 'public.t', hit_rate: null as string | null, total: 1 };

  it('keeps an index with no I/O yet as null, never 0%', () => {
    expect(toIndexCaching([row]).indexes[0]!.hitRate).toBeNull();
  });

  it('rounds exactly as the database-wide rate does, so the two agree', () => {
    expect(toIndexCaching([{ ...row, hit_rate: '0.99997477931904161412' }]).indexes[0]!.hitRate).toBe(100);
    expect(toIndexCaching([{ ...row, hit_rate: '0.9912' }]).indexes[0]!.hitRate).toBe(99.12);
  });

  it('keeps a genuine zero, which is not the same as unknown', () => {
    expect(toIndexCaching([{ ...row, hit_rate: '0' }]).indexes[0]!.hitRate).toBe(0);
  });

  it('takes truncated from the pre-LIMIT total', () => {
    expect(toIndexCaching([{ ...row, total: 9 }]).truncated).toBe(true);
  });

  it('reports an empty view as empty', () => {
    expect(toIndexCaching([])).toEqual({ indexes: [], total: 0, truncated: false });
  });
});

describe('toStatsReset', () => {
  it('reports a never-reset database as null, not as an epoch', () => {
    expect(toStatsReset([{ stats_reset: null }])).toEqual({ statsReset: null });
  });

  it('passes a real timestamp through untouched', () => {
    expect(toStatsReset([{ stats_reset: '2026-09-11 06:00:00+00' }]))
      .toEqual({ statsReset: '2026-09-11 06:00:00+00' });
  });

  it('reports a missing row as null rather than undefined', () => {
    expect(toStatsReset([])).toEqual({ statsReset: null });
  });
});

/**
 * §2.2: these three are among the nineteen that ship as tables an operator
 * reads. `runCheck` does `check.verdict?.(…) ?? null`, so an absent function
 * yields `verdict: null` and `CheckPanel` renders no badge. Asserting the
 * absence here is what stops someone adding a verdict to an inventory later
 * and quietly painting a green badge on a list that has no opinion.
 */
describe('the inventory checks do not escalate', () => {
  it('has no verdict function on any of the three', () => {
    expect(indexList.verdict).toBeUndefined();
    expect(indexCaching.verdict).toBeUndefined();
    expect(lastStatsReset.verdict).toBeUndefined();
  });

  it('declares no thresholds either, since there is nothing to cross', () => {
    expect(indexList.thresholds).toBeUndefined();
    expect(indexCaching.thresholds).toBeUndefined();
    expect(lastStatsReset.thresholds).toBeUndefined();
  });
});

describe('toFindings', () => {
  const row = { name: 'public.ix_a', table_name: 'public.t', size_bytes: '13500416', total: 1 };

  it('converts a bigint size out of text', () => {
    expect(toFindings([row]).indexes[0]!.sizeBytes).toBe(13500416);
  });

  it('takes truncated from the pre-LIMIT total', () => {
    expect(toFindings([{ ...row, total: 40 }])).toMatchObject({ total: 40, truncated: true });
  });

  it('reports a clean database as empty', () => {
    expect(toFindings([])).toEqual({ indexes: [], total: 0, truncated: false });
  });
});

/**
 * The §5 rule where it actually bites. An earlier draft escalated on
 * `rows.length`, so with a cap of one and forty invalid indexes the operator
 * read "1 invalid index" — a number that is simply wrong, under a list that
 * was silently truncated.
 */
describe('invalidIndexes verdict', () => {
  const t = () => invalidIndexes.thresholds!;
  const data = (total: number) => ({ indexes: [], total, truncated: false });

  it('is ok on a database with none', () => {
    expect(invalidIndexes.verdict!(data(0), t())).toEqual({ level: 'ok' });
  });

  it('warns at exactly one, which is pgHero s rule', () => {
    expect(invalidIndexes.verdict!(data(1), t()).level).toBe('warn');
  });

  it('counts every invalid index, not the ones that fit under the cap', () => {
    expect(invalidIndexes.verdict!(data(40), t()).note).toContain('40');
  });

  it('says index, not indexes, when there is exactly one', () => {
    expect(invalidIndexes.verdict!(data(1), t()).note).toBe('1 invalid index');
  });

  /**
   * The threshold is what the page shows an operator beside the badge, so a
   * DDL statement here would also be advice they might paste. It stays prose
   * for a second reason: `guards.test.ts` confines DDL to run.ts, and
   * 'REINDEX INDEX CONCURRENTLY ...' matches its regex.
   */
  it('carries a remedy, and it is prose rather than a statement', () => {
    const remedy = t()[0]!.remedy!;
    expect(remedy).toBeTruthy();
    expect(remedy).not.toMatch(/\b(?:CREATE|ALTER|DROP|REINDEX)\s+(?:INDEX|TABLE)\b/);
  });
});

describe('unusedIndexes verdict', () => {
  const t = () => unusedIndexes.thresholds!;
  const data = (total: number) => ({ indexes: [], total, truncated: false });

  it('is ok when nothing cleared the floor', () => {
    expect(unusedIndexes.verdict!(data(0), t())).toEqual({ level: 'ok' });
  });

  it('warns as soon as one index qualifies', () => {
    expect(unusedIndexes.verdict!(data(1), t())).toEqual({ level: 'warn', note: '1 unused index' });
  });

  it('counts every qualifying index, not the ones under the cap', () => {
    expect(unusedIndexes.verdict!(data(12), t()).note).toContain('12');
  });

  /**
   * The declared threshold and the floor the query applies must be the same
   * number. An earlier draft declared `value: 10, unit: 'bytes'` next to a
   * query using `10 * 1024 * 1024`, so the panel told the operator the floor
   * was ten bytes.
   */
  it('declares the floor in bytes, matching the value the query filters on', () => {
    expect(t()[0]).toMatchObject({ unit: 'bytes', value: 10 * 1024 * 1024 });
  });
});

describe('toDuplicates', () => {
  const row = {
    name: 'public.ix_c1', covered_by: 'public.ix_c1_c2', table_name: 'public.w',
    size_bytes: '8192', total: 1,
  };

  it('pairs the redundant index with the one that covers it', () => {
    expect(toDuplicates([row]).pairs[0]).toEqual({
      name: 'public.ix_c1', coveredBy: 'public.ix_c1_c2', table: 'public.w', sizeBytes: 8192,
    });
  });

  it('converts a bigint size out of text', () => {
    expect(toDuplicates([{ ...row, size_bytes: '13500416' }]).pairs[0]!.sizeBytes).toBe(13500416);
  });

  it('takes truncated from the pre-LIMIT total', () => {
    expect(toDuplicates([{ ...row, total: 9 }])).toMatchObject({ total: 9, truncated: true });
  });

  it('reports a database with no duplicates as empty', () => {
    expect(toDuplicates([])).toEqual({ pairs: [], total: 0, truncated: false });
  });

  /**
   * `DISTINCT ON (a.indexrelid)` means one row per REDUNDANT INDEX, not one
   * per covering relationship — an index covered by three others is one
   * problem, not three. `total` therefore counts indexes an operator could
   * drop, which is what any page rendering this must say.
   */
  it('counts redundant indexes, so total matches the rows it caps', () => {
    const rows = [row, { ...row, name: 'public.ix_c1_copy', total: 2 }].map((r) => ({ ...r, total: 2 }));
    expect(toDuplicates(rows)).toMatchObject({ total: 2, truncated: false });
  });
});

/**
 * A duplicate index is sometimes deliberate — kept through a migration, or
 * held for a rebuild — so a database with one is not thereby unhealthy.
 * §2.2, and the reason this destructive recommendation never escalates on
 * its own.
 */
describe('duplicateIndexes does not escalate', () => {
  it('has no verdict and no thresholds', () => {
    expect(duplicateIndexes.verdict).toBeUndefined();
    expect(duplicateIndexes.thresholds).toBeUndefined();
  });
});

describe('toTableUsage', () => {
  const row = { name: 'public.t', index_hit_rate: '94.5' as string | null, estimated_rows: '20000', total: 1 };

  /**
   * The dangerous shape, and the reason it is worth its own test: a null rate
   * on a LARGE table. `idx_scan` is NULL for a table with no indexes at all,
   * so this row is a big, heavily seq-scanned, index-less table — the one
   * most obviously wanting an index. Collapsing the null to 0 would render it
   * as "0% of scans used an index", which is indistinguishable from a table
   * whose indexes are simply being ignored, and the two call for different
   * actions.
   */
  it('keeps a null rate null even on a large table', () => {
    const d = toTableUsage([{ ...row, index_hit_rate: null, estimated_rows: '4000000' }]);
    expect(d.tables[0]!.indexHitRate).toBeNull();
    expect(d.tables[0]!.estimatedRows).toBe(4000000);
  });

  it('rounds a present rate to two decimals', () => {
    expect(toTableUsage([{ ...row, index_hit_rate: '94.44444444444444444444' }]).tables[0]!.indexHitRate)
      .toBe(94.44);
  });

  it('keeps a genuine zero, which is not the same as unknown', () => {
    expect(toTableUsage([{ ...row, index_hit_rate: '0' }]).tables[0]!.indexHitRate).toBe(0);
  });

  it('converts a bigint row estimate out of text', () => {
    // n_live_tup is bigint; a table past 2^31 rows is not exotic.
    expect(toTableUsage([{ ...row, estimated_rows: '3000000000' }]).tables[0]!.estimatedRows)
      .toBe(3000000000);
  });

  it('takes truncated from the pre-LIMIT total', () => {
    expect(toTableUsage([{ ...row, total: 80 }])).toMatchObject({ total: 80, truncated: true });
  });

  it('reports an empty database as empty', () => {
    expect(toTableUsage([])).toEqual({ tables: [], total: 0, truncated: false });
  });
});

describe('the usage checks do not escalate', () => {
  it('has no verdict and no thresholds on either', () => {
    expect(indexUsage.verdict).toBeUndefined();
    expect(indexUsage.thresholds).toBeUndefined();
    expect(missingIndexes.verdict).toBeUndefined();
    expect(missingIndexes.thresholds).toBeUndefined();
  });
});
