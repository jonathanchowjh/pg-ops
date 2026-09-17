import { describe, expect, it } from 'vitest';
import { indexBloat, toIndexBloat } from '../src/checks/index-bloat.js';

const row = (over: Partial<Parameters<typeof toIndexBloat>[0][number]> = {}) => ({
  schema: 'public',
  table_name: 't',
  index_name: 'ix_a',
  bloat_bytes: '16384',
  index_bytes: '131072',
  definition: 'CREATE INDEX ix_a ON public.t USING btree (a)',
  is_primary: false,
  total: 1,
  ...over,
});

describe('toIndexBloat', () => {
  it('returns an empty list and a zero total when nothing clears the floor', () => {
    expect(toIndexBloat([])).toEqual({ indexes: [], total: 0, truncated: false });
  });

  /**
   * Both figures arrive as text, because bigint through node-postgres would
   * otherwise round through a float64. `Number` at the map layer is the same
   * seam every other size in this package uses.
   */
  it('converts both byte figures from the text the query returns', () => {
    const { indexes } = toIndexBloat([row()]);
    expect(indexes[0]!.bloatBytes).toBe(16384);
    expect(indexes[0]!.indexBytes).toBe(131072);
  });

  it('keeps a genuinely unbloated index at zero wasted bytes', () => {
    const { indexes } = toIndexBloat([row({ bloat_bytes: '0' })]);
    expect(indexes[0]!.bloatBytes).toBe(0);
  });

  /**
   * The qualification the query deliberately does not do, so the transcribed
   * estimator stays diffable against pgHero's. Both names take the SAME
   * schema — the index and its table always share one.
   */
  it('qualifies both the index and its table from the single schema column', () => {
    const { indexes } = toIndexBloat([row({ schema: 'other' })]);
    expect(indexes[0]!.name).toBe('other.ix_a');
    expect(indexes[0]!.table).toBe('other.t');
  });

  it('passes the index definition through untouched', () => {
    const def = 'CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)';
    const { indexes } = toIndexBloat([row({ definition: def })]);
    expect(indexes[0]!.definition).toBe(def);
  });

  it('carries the primary-key flag, which decides whether dropping is even an option', () => {
    expect(toIndexBloat([row({ is_primary: true })]).indexes[0]!.primary).toBe(true);
    expect(toIndexBloat([row({ is_primary: false })]).indexes[0]!.primary).toBe(false);
  });

  it('reads truncation from the pre-LIMIT total, not the row count', () => {
    expect(toIndexBloat([row({ total: 12 })])).toMatchObject({ total: 12, truncated: true });
  });

  it('is not truncated when the total matches what came back', () => {
    expect(toIndexBloat([row({ total: 1 })]).truncated).toBe(false);
  });
});

describe('the indexBloat contract', () => {
  /**
   * §2 and types.ts: `on-demand` exists SO THAT this check is a class member
   * rather than an exception written in prose. If this assertion ever has to
   * change, that design has been abandoned and the class has no other member
   * to justify it.
   */
  it('is the on-demand check, at the keep-up gate', () => {
    expect(indexBloat.class).toBe('on-demand');
    expect(indexBloat.gate).toBe('keep-up');
  });

  /**
   * 30s, not hygiene's 10s. Five CTEs over pg_stats and pg_class is a check
   * an operator navigates to and waits for; pgHero reaches the same
   * conclusion by shipping it disabled on its own dashboard.
   */
  it('budgets 30 seconds, three times what a hygiene check gets', () => {
    expect(indexBloat.timeoutMs).toBe(30_000);
  });

  it('never escalates on its own', () => {
    expect(indexBloat.verdict).toBeUndefined();
  });

  it("floors at pgHero's 100 megabytes of wasted space", () => {
    const warn = indexBloat.thresholds!.find((t) => t.level === 'warn')!;
    expect(warn.value).toBe(104857600);
    expect(warn.unit).toBe('bytes');
    expect(warn.because).toContain('index_bloat_bytes');
  });

  /**
   * The floor is declared once, as the threshold value, and the query reads
   * it from there — so the Guidance an operator reads and the number the
   * query applied cannot drift apart. `unusedIndexes` documents the same rule
   * after an earlier draft told operators its floor was ten BYTES.
   */
  it('applies the threshold value as the query default, not a second literal', () => {
    const warn = indexBloat.thresholds!.find((t) => t.level === 'warn')!;
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })({});
    expect(built.values[0]).toBe(warn.value);
  });

  it('overrides the floor and the cap when asked', () => {
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })(
      { minBytes: 0, limit: 5 });
    expect(built.values).toEqual([0, 5]);
  });

  /**
   * `0` must survive as a floor. `??` and not `||`: a caller asking for every
   * index regardless of waste passes 0, and `||` would silently restore the
   * 100 MB default and return nothing.
   */
  it('honours a zero floor rather than falling back to the default', () => {
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })({ minBytes: 0 });
    expect(built.values[0]).toBe(0);
  });
});
