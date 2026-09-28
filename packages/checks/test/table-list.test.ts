import { describe, expect, it } from 'vitest';
import { TABLE_SORTS, tableList, toTableList, type TableListOpts, type TableListRow } from '../src/checks/table-list.js';

const row: TableListRow = {
  name: 'public.orders',
  size_bytes: '4096',
  live_rows: '120',
  dead_rows: '7',
  seq_scans: '3',
  idx_scans: '900',
  hit_rate: '0.994',
  last_vacuum: new Date('2026-09-20T00:00:00Z'),
  last_analyze: null,
  total: 1,
};

describe('toTableList', () => {
  it('reads the pre-LIMIT total rather than the row count', () => {
    const data = toTableList([{ ...row, total: 250 }]);
    expect(data).toMatchObject({ total: 250, truncated: true });
    expect(data.tables).toHaveLength(1);
  });

  it('is empty and untruncated when nothing came back', () => {
    expect(toTableList([])).toEqual({ tables: [], total: 0, truncated: false });
  });

  /**
   * A hit rate of null means "no heap I/O has been recorded for this table",
   * which is not the same as a hit rate of zero. Zero is a table being read
   * entirely from disk — the worst reading there is — and rendering "we have
   * not looked" as the worst reading there is would send an operator to fix
   * a table nobody has touched.
   */
  it('keeps an unmeasured hit rate null rather than folding it to zero', () => {
    expect(toTableList([{ ...row, hit_rate: null }]).tables[0]!.hitRate).toBeNull();
    expect(toTableList([{ ...row, hit_rate: '0' }]).tables[0]!.hitRate).toBe(0);
  });

  it('converts the text-carried counters to numbers', () => {
    const t = toTableList([row]).tables[0]!;
    expect(t).toMatchObject({
      name: 'public.orders', sizeBytes: 4096, liveRows: 120, deadRows: 7,
      seqScans: 3, idxScans: 900,
    });
  });

  /**
   * `idx_scan` is NULL, not 0, for a table with no indexes at all —
   * `pg_stat_user_tables.idx_scan` is a `sum()` over a LEFT JOIN to
   * `pg_index`, and there is no row for such a table to sum. Folding that to
   * zero renders "Index scans: 0" for a table that could never have had an
   * index scan in the first place, indistinguishable on the page from an
   * indexed table nobody has queried by index yet. Mirrors the `hit_rate`
   * test above — same discipline, same column shape.
   */
  it('keeps an unmeasured idx_scans null rather than folding it to zero', () => {
    expect(toTableList([{ ...row, idx_scans: null }]).tables[0]!.idxScans).toBeNull();
    expect(toTableList([{ ...row, idx_scans: '0' }]).tables[0]!.idxScans).toBe(0);
  });
});

describe('the tableList check', () => {
  /**
   * §2.2: an inventory is a table an operator reads, not a finding. Asserted
   * rather than assumed, because adding a verdict here would also break
   * areas.test.ts's exact list of areas that escalate.
   */
  it('reports without judging', () => {
    expect(tableList.verdict).toBeUndefined();
    expect(tableList.thresholds).toBeUndefined();
  });

  it('is hygiene, on the work gate, with the shared hygiene timeout', () => {
    expect(tableList.class).toBe('hygiene');
    expect(tableList.gate).toBe('work');
    expect(tableList.timeoutMs).toBe(10_000);
  });

  /**
   * THE SORT IS A CLOSED SET, and this is why it is interpolated safely.
   * query-stats.ts:349-355 states the rule for the only other interpolated
   * ORDER BY in the package: it is safe because the key comes from a closed
   * Record and the type must never be widened to `string`. This test is the
   * mechanical half of that promise — every member of the union has an entry,
   * and nothing else can reach the interpolation.
   */
  it('has an ORDER BY for every sort it admits, and admits nothing else', () => {
    const q = (sort: unknown) =>
      (tableList.sql as (o: unknown) => { text: string })({ sort });
    for (const sort of TABLE_SORTS) {
      expect(q(sort).text, `sort ${sort}`).toMatch(/ORDER BY \S/);
    }
    expect(() => q('; DROP TABLE orders --')).toThrow(/unknown sort/i);
  });

  it('defaults to the largest tables first', () => {
    const text = (tableList.sql as (o: unknown) => { text: string })({}).text;
    expect(text).toContain('size_num DESC');
  });

  /**
   * Every field optional, because capture.ts:447-456 runs every hygiene check
   * as `runCheck(ctx, check, {})`. A required opt does not fail a type check
   * there — the scheduler casts — it fails at runtime, on the scheduler, in
   * production.
   */
  it('runs with no options at all', () => {
    expect(() => (tableList.sql as (o: unknown) => unknown)({})).not.toThrow();
  });

  /**
   * `search` is bound into `'%' || $4 || '%'`, so an unescaped `_` in the
   * search term is itself an ILIKE wildcard (any one character) rather than
   * a literal underscore — this is the case a real search box hits first,
   * since underscores are common in table names. `%` and a literal `\` get
   * the same treatment for the same reason. Checked on the bound VALUE, not
   * the query text: the escaping happens in `sqlFor`, not in the SQL itself.
   */
  it('escapes ILIKE wildcards in the search term before binding it', () => {
    const q = (search: string) =>
      (tableList.sql as (o: TableListOpts) => { values: unknown[] })({ search });
    expect(q('order_item').values[3]).toBe('order\\_item');
    expect(q('50%off').values[3]).toBe('50\\%off');
    expect(q('a\\b').values[3]).toBe('a\\\\b');
  });
});
