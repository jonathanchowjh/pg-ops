import { describe, expect, it } from 'vitest';
import {
  tableCaching, tableHitRate, tableStats, unusedTables,
  toTableCaching, toTableStats, toUnusedTables,
} from '../src/checks/tables.js';

describe('toTableCaching', () => {
  /**
   * The divergence from pgHero, at the map layer. pgHero's SQL says
   * `CASE WHEN heap_blks_hit + heap_blks_read = 0 THEN 0`, which renders a
   * table nothing has read yet as 0% cached — a fabricated worst case that
   * sorts to the top of a page ranked by how bad the reading is.
   */
  it('keeps a null hit rate as null rather than collapsing it to zero', () => {
    const { tables } = toTableCaching([
      { table_name: 'public.untouched', hit_rate: null, total: 1 },
    ]);
    expect(tables[0]!.hitRate).toBeNull();
  });

  it('keeps a genuine zero, which is a reading and not a gap', () => {
    const { tables } = toTableCaching([
      { table_name: 'public.cold', hit_rate: '0', total: 1 },
    ]);
    expect(tables[0]!.hitRate).toBe(0);
  });

  /**
   * Two decimals, the same rounding `toRate` applies to the database-wide
   * figure, so one table's rate and the summary are one value formatted one
   * way. Postgres returns numeric division at 20 decimal places.
   */
  it('rounds to two decimals, matching the database-wide rate', () => {
    const { tables } = toTableCaching([
      { table_name: 'public.t', hit_rate: '0.99193548387096774194', total: 1 },
    ]);
    expect(tables[0]!.hitRate).toBe(99.19);
  });

  it('reads truncation from the pre-LIMIT total, not the row count', () => {
    expect(toTableCaching([{ table_name: 'public.t', hit_rate: '1', total: 9 }]))
      .toMatchObject({ total: 9, truncated: true });
  });

  it('returns an empty list and a zero total for a database with no tables', () => {
    expect(toTableCaching([])).toEqual({ tables: [], total: 0, truncated: false });
  });
});

describe('toUnusedTables', () => {
  it('converts the bigint row estimate, which arrives as text', () => {
    const { tables } = toUnusedTables([
      { table_name: 'public.t', estimated_rows: '9007199254740991', total: 1 },
    ]);
    expect(tables[0]!.estimatedRows).toBe(9007199254740991);
  });

  it('keeps a zero-row table at zero rather than treating it as missing', () => {
    const { tables } = toUnusedTables([
      { table_name: 'public.empty', estimated_rows: '0', total: 1 },
    ]);
    expect(tables[0]!.estimatedRows).toBe(0);
  });

  it('reads truncation from the pre-LIMIT total', () => {
    expect(toUnusedTables([{ table_name: 'public.t', estimated_rows: '5', total: 4 }]))
      .toMatchObject({ total: 4, truncated: true });
  });
});

describe('toTableStats', () => {
  const base = {
    table_name: 'public.t',
    live_rows: '600',
    dead_rows: '400',
    last_vacuum: null,
    last_autovacuum: null,
    last_analyze: null,
    last_autoanalyze: null,
    total: 1,
  };

  it('converts both bigint tuple counts', () => {
    const { tables } = toTableStats([base]);
    expect(tables[0]!.liveRows).toBe(600);
    expect(tables[0]!.deadRows).toBe(400);
  });

  /**
   * All four timestamps mean "never" when null, which is the finding on a
   * keep-up page. Defaulting any of them — to the epoch, to now — would turn
   * a table maintenance has never touched into one that looks attended to.
   */
  it('passes all four maintenance timestamps through as null for never', () => {
    const { tables } = toTableStats([base]);
    expect(tables[0]!.lastVacuum).toBeNull();
    expect(tables[0]!.lastAutovacuum).toBeNull();
    expect(tables[0]!.lastAnalyze).toBeNull();
    expect(tables[0]!.lastAutoanalyze).toBeNull();
  });

  it('distinguishes a manual vacuum from an autovacuum', () => {
    const when = new Date('2026-09-14T02:00:00Z');
    const { tables } = toTableStats([{ ...base, last_vacuum: when }]);
    expect(tables[0]!.lastVacuum).toBe(when);
    expect(tables[0]!.lastAutovacuum).toBeNull();
  });

  it('reads truncation from the pre-LIMIT total', () => {
    expect(toTableStats([{ ...base, total: 3 }])).toMatchObject({ total: 3, truncated: true });
  });

  it('returns an empty list and a zero total for a database with no tables', () => {
    expect(toTableStats([])).toEqual({ tables: [], total: 0, truncated: false });
  });
});

describe('the tables checks contract', () => {
  /**
   * §2.2: a list reports, it does not escalate. `tableHitRate` is the one
   * reading here with a scale, so it is the one with a verdict.
   */
  it('gives the three list checks no verdict at all', () => {
    expect(tableCaching.verdict).toBeUndefined();
    expect(unusedTables.verdict).toBeUndefined();
    expect(tableStats.verdict).toBeUndefined();
  });

  it('gives tableHitRate the same 99 percent threshold as the index rate', () => {
    const warn = tableHitRate.thresholds!.find((t) => t.level === 'warn')!;
    expect(warn.value).toBe(99);
    expect(warn.unit).toBe('percent');
    expect(warn.because).toContain('cache_hit_rate_threshold');
  });

  /**
   * The shared `rateVerdict` from indexes.ts, not a second copy: an
   * unmeasurable rate must not escalate, or every freshly started database
   * warns on a page it has no reading for.
   */
  it('does not warn on a null table hit rate', () => {
    expect(tableHitRate.verdict!({ rate: null }, tableHitRate.thresholds!))
      .toEqual({ level: 'ok' });
  });

  it('warns below 99 percent and stays ok at 99', () => {
    expect(tableHitRate.verdict!({ rate: 98.4 }, tableHitRate.thresholds!).level).toBe('warn');
    expect(tableHitRate.verdict!({ rate: 99 }, tableHitRate.thresholds!).level).toBe('ok');
  });

  /** One of the three the spec names where the gate is not the page. */
  it('puts tableStats on keep-up and the other three on work', () => {
    expect(tableStats.gate).toBe('keep-up');
    expect(tableHitRate.gate).toBe('work');
    expect(tableCaching.gate).toBe('work');
    expect(unusedTables.gate).toBe('work');
  });

  it('runs all four under the hygiene scheduler', () => {
    for (const c of [tableHitRate, tableCaching, unusedTables, tableStats]) {
      expect(c.class).toBe('hygiene');
    }
  });
});
