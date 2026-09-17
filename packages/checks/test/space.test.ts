import { describe, expect, it } from 'vitest';
import {
  databaseSize, relationSizes, tableSizes,
  toDatabaseSize, toRelationSizes, toTableSizes,
} from '../src/checks/space.js';

describe('toDatabaseSize', () => {
  /**
   * §3: bytes cross the boundary, never pgHero's `pretty_size` string. P4
   * charts growth from these numbers, and "8192 MB" cannot be charted.
   */
  it('converts the bigint size, which arrives as text', () => {
    expect(toDatabaseSize([{ size_bytes: '56481459' }])).toEqual({ sizeBytes: 56481459 });
  });

  it('reads null as null, not as a zero-byte database', () => {
    expect(toDatabaseSize([{ size_bytes: null }])).toEqual({ sizeBytes: null });
  });

  it('returns null for no row rather than inventing a reading', () => {
    expect(toDatabaseSize([])).toEqual({ sizeBytes: null });
  });

  /**
   * A size beyond 2^53 would lose precision as a float64, which is why the
   * query casts to text. 9 PB is not a realistic database, but the seam has
   * to be the one that could carry one.
   */
  it('does not round a size through a float32-sized integer', () => {
    expect(toDatabaseSize([{ size_bytes: '9007199254740991' }]).sizeBytes)
      .toBe(9007199254740991);
  });
});

describe('toRelationSizes', () => {
  const row = (name: string, type: 'table' | 'matview' | 'index', bytes: string, total = 1) =>
    ({ name, type, size_bytes: bytes, total });

  it('returns an empty list and a zero total for a database with no relations', () => {
    expect(toRelationSizes([])).toEqual({ relations: [], total: 0, truncated: false });
  });

  it('keeps the relation kind, so an index is distinguishable from its table', () => {
    const { relations } = toRelationSizes([
      row('public.t', 'table', '1000', 2),
      row('public.ix', 'index', '500', 2),
    ]);
    expect(relations.map((r) => r.type)).toEqual(['table', 'index']);
  });

  it('converts sizes to numbers rather than leaving them as text', () => {
    const { relations } = toRelationSizes([row('public.t', 'table', '1843200')]);
    expect(relations[0]!.sizeBytes).toBe(1843200);
  });

  it('keeps a zero-byte relation, which is a reading and not a gap', () => {
    expect(toRelationSizes([row('public.empty', 'table', '0')]).relations[0]!.sizeBytes).toBe(0);
  });

  it('reads truncation from the pre-LIMIT total, not the row count', () => {
    expect(toRelationSizes([row('public.t', 'table', '1', 40)]))
      .toMatchObject({ total: 40, truncated: true });
  });

  it('is not truncated when the total matches what came back', () => {
    expect(toRelationSizes([row('public.t', 'table', '1', 1)]).truncated).toBe(false);
  });
});

describe('toTableSizes', () => {
  it('returns an empty list and a zero total for a database with no tables', () => {
    expect(toTableSizes([])).toEqual({ relations: [], total: 0, truncated: false });
  });

  it('converts sizes to numbers', () => {
    const { relations } = toTableSizes([
      { name: 'public.t', size_bytes: '2990080', total: 1 },
    ]);
    expect(relations[0]!).toEqual({ name: 'public.t', sizeBytes: 2990080 });
  });

  it('reads truncation from the pre-LIMIT total', () => {
    expect(toTableSizes([{ name: 'public.t', size_bytes: '1', total: 9 }]))
      .toMatchObject({ total: 9, truncated: true });
  });
});

describe('the space checks contract', () => {
  /** §2.2: there is no size at which a database is "wrong". */
  it('gives none of the three a verdict', () => {
    expect(databaseSize.verdict).toBeUndefined();
    expect(relationSizes.verdict).toBeUndefined();
    expect(tableSizes.verdict).toBeUndefined();
  });

  it('puts all three at the keep-up gate, under the hygiene scheduler', () => {
    for (const c of [databaseSize, relationSizes, tableSizes]) {
      expect(c.gate).toBe('keep-up');
      expect(c.class).toBe('hygiene');
      expect(c.timeoutMs).toBe(10_000);
    }
  });

  /**
   * The two size functions are the whole difference between #38 and #39, and
   * swapping them double-counts every index in the database. Asserted on the
   * SQL because the behavioural proof needs a live server, where
   * space.int.test.ts makes it.
   */
  it('uses pg_table_size for relations and pg_total_relation_size for tables', () => {
    const rels = (relationSizes.sql as (o: object) => { text: string })({}).text;
    const tables = (tableSizes.sql as (o: object) => { text: string })({}).text;
    expect(rels).toContain('pg_table_size(');
    expect(rels).not.toContain('pg_total_relation_size(');
    expect(tables).toContain('pg_total_relation_size(');
  });

  /**
   * The size is computed once and both the filter and the ordering read that
   * column — three calls per row would also make the IS NOT NULL guard
   * incoherent, since the call that passed the filter is not the call whose
   * value is returned.
   */
  /**
   * The guard a mutation cannot otherwise reach. Deleting `size_num IS NOT
   * NULL` broke no test, because it only matters for a relation dropped
   * between the catalog scan and the size call — a race that cannot be
   * staged. space.int.test.ts pins the premise (these functions return NULL
   * rather than raising); this pins that the filter is still there.
   */
  it('filters out a relation whose size came back null', () => {
    for (const check of [relationSizes, tableSizes]) {
      const text = (check.sql as (o: object) => { text: string })({}).text;
      expect(text).toContain('WHERE size_num IS NOT NULL');
    }
  });

  it('computes each size exactly once per row', () => {
    const rels = (relationSizes.sql as (o: object) => { text: string })({}).text;
    expect(rels.match(/pg_table_size\(/g) ?? []).toHaveLength(1);
    const tables = (tableSizes.sql as (o: object) => { text: string })({}).text;
    expect(tables.match(/pg_total_relation_size\(/g) ?? []).toHaveLength(1);
  });
});
