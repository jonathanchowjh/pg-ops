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

  /** Both figures arrive as text, because bigint through node-postgres would round through a float64. */
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
   * The query does not qualify names, so the estimator stays diffable against
   * pgHero's. An index and its table always share one schema.
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
  /** Captured, but never by the capture: a button runs it. */
  it('is a captured check on the index node', () => {
    expect(indexBloat.class).toBe('captured');
    expect(indexBloat.home).toBe('index');
  });

  /** 30s, not a captured read's 10s: an operator asks for this check and waits for it. */
  it('budgets 30 seconds, three times what a captured read gets', () => {
    expect(indexBloat.timeoutMs).toBe(30_000);
  });

  it("floors at pgHero's 100 megabytes of wasted space", () => {
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })({});
    expect(built.values[0]).toBe(104857600);
  });

  it('overrides the floor and the cap when asked', () => {
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })(
      { minBytes: 0, limit: 5 });
    expect(built.values).toEqual([0, 5]);
  });

  /** `??` and not `||`: `||` would turn a floor of 0 back into the 100 MB default. */
  it('honours a zero floor rather than falling back to the default', () => {
    const built = (indexBloat.sql as (o: object) => { values: unknown[] })({ minBytes: 0 });
    expect(built.values[0]).toBe(0);
  });
});
