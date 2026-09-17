import { describe, expect, it } from 'vitest';
import { invalidConstraints, toConstraints } from '../src/checks/constraints.js';

const row = (name: string, table: string, total: number) => ({
  name,
  table_name: table,
  definition: `CHECK ((${name} > 0)) NOT VALID`,
  total,
});

describe('toConstraints', () => {
  it('returns an empty list and a zero total for a database with none', () => {
    expect(toConstraints([])).toEqual({ constraints: [], total: 0, truncated: false });
  });

  it('passes the constraint definition through untouched', () => {
    const def = 'FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID';
    const { constraints } = toConstraints([
      { name: 'child_fk', table_name: 'public.child', definition: def, total: 1 },
    ]);
    expect(constraints[0]!.definition).toBe(def);
  });

  it('keeps the schema-qualified table, which is what tells two same-named rows apart', () => {
    const { constraints } = toConstraints([
      row('child_n_positive', 'other.child', 2),
      row('child_n_positive', 'public.child', 2),
    ]);
    expect(constraints.map((c) => c.table)).toEqual(['other.child', 'public.child']);
    expect(new Set(constraints.map((c) => c.name)).size).toBe(1);
  });

  /**
   * §5's arithmetic. `total` comes from `count(*) OVER ()`, which Postgres
   * computes BEFORE the LIMIT, so it is the only number that knows how much
   * the cap hid.
   */
  it('reads truncation from the pre-LIMIT total, not the row count', () => {
    expect(toConstraints([row('c_a', 'public.t', 3)])).toMatchObject({ total: 3, truncated: true });
  });

  it('is not truncated when the total matches what came back', () => {
    expect(toConstraints([row('c_a', 'public.t', 1)]).truncated).toBe(false);
  });

  /**
   * A row set is either empty or every row carries the same window count, so
   * reading row 0 is safe — but `?? 0` is what makes the empty case a real
   * zero instead of `undefined` leaking into the verdict's comparison.
   */
  it('does not read a total off a row that is not there', () => {
    expect(toConstraints([]).total).toBe(0);
  });
});

describe('invalidConstraints verdict', () => {
  const t = () => invalidConstraints.thresholds!;
  const data = (total: number) => ({ constraints: [], total, truncated: false });

  it('is ok on a database with nothing unvalidated', () => {
    expect(invalidConstraints.verdict!(data(0), t())).toEqual({ level: 'ok' });
  });

  it('warns at exactly one, which is pgHero s rule', () => {
    expect(invalidConstraints.verdict!(data(1), t()).level).toBe('warn');
  });

  it('says "constraint", singular, for one', () => {
    expect(invalidConstraints.verdict!(data(1), t()).note).toBe('1 unvalidated constraint');
  });

  /**
   * The reason this check does not reuse `findingVerdict` from indexes.ts,
   * which is otherwise the identical shape: that one pluralises with `es`,
   * for "index/indexes", and would render "7 unvalidated constraintes".
   */
  it('pluralises with s, not the es that indexes.ts uses', () => {
    expect(invalidConstraints.verdict!(data(7), t()).note).toBe('7 unvalidated constraints');
  });

  it('counts every finding, not the ones that fit under the cap', () => {
    expect(invalidConstraints.verdict!(data(40), t()).note).toContain('40');
  });

  /**
   * Convention 3: no non-null assertion on `find`. A check may be run with
   * thresholds it was not given, and the verdict must still return a level.
   */
  it('does not escalate when it was given no warn threshold', () => {
    expect(invalidConstraints.verdict!(data(40), [])).toEqual({ level: 'ok' });
  });
});

describe('invalidConstraints contract', () => {
  /**
   * One of the three the spec names where the gate is deliberately not the
   * page. `keep-up` is the gate of the READING — maintenance debt — while
   * the page groups it beside invalidIndexes, which is a `work` page.
   */
  it('is a keep-up hygiene check, whatever page renders it', () => {
    expect(invalidConstraints.gate).toBe('keep-up');
    expect(invalidConstraints.class).toBe('hygiene');
  });

  it('carries a remedy that is prose, never a statement the DDL guard would catch', () => {
    const remedy = invalidConstraints.thresholds![0]!.remedy!;
    expect(remedy).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i);
    expect(remedy.length).toBeGreaterThan(0);
  });
});
