import { describe, expect, it } from 'vitest';
import { sequences, toSequences, type SequenceRow } from '../src/checks/sequences.js';

const row = (over: Partial<SequenceRow> = {}): SequenceRow => ({
  name: 'public.s',
  table_name: 'public.t',
  column_name: 'id',
  column_type: 'integer',
  max_value: '2147483647',
  last_value: '1',
  readable: true,
  unreadable: 0,
  worst_pct: '0.0000000005',
  total: 1,
  ...over,
});

describe('toSequences', () => {
  it('returns an empty list and zero counts for a database with no sequences', () => {
    expect(toSequences([])).toEqual({
      sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed: null,
    });
  });

  /** 2,000,000,000 / 2,147,483,647 = 93.13%. */
  it('measures an integer column at two billion as 93 percent used', () => {
    const { sequences: s } = toSequences([row({ last_value: '2000000000' })]);
    expect(s[0]!.pctUsed!.toFixed(2)).toBe('93.13');
  });

  it('measures a smallint column at its ceiling as exactly 100 percent', () => {
    const { sequences: s } = toSequences([
      row({ column_type: 'smallint', max_value: '32767', last_value: '32767' }),
    ]);
    expect(s[0]!.pctUsed).toBe(100);
  });

  /**
   * The ceiling is asserted directly: `pctUsed < 0.001` would pass whether
   * the ceiling is the bigint maximum or the integer one.
   */
  it('takes a bigint column to the bigint ceiling, not the integer one', () => {
    const { sequences: s } = toSequences([
      row({ column_type: 'bigint', max_value: '9223372036854775807', last_value: '5000000000' }),
    ]);
    expect(s[0]!.maxValue).toBeGreaterThan(2147483647);
    // 9223372036854775807 is not representable as a JS number and arrives as
    // 9223372036854776000. Harmless for the percentage (~1e-16 relative).
    expect(s[0]!.maxValue).toBe(9223372036854776000);
  });

  it('reports the same value as dangerous on an integer column and harmless on a bigint one', () => {
    const asInt = toSequences([row({ last_value: '2000000000' })]).sequences[0]!;
    const asBig = toSequences([
      row({ column_type: 'bigint', max_value: '9223372036854775807', last_value: '2000000000' }),
    ]).sequences[0]!;
    expect(asInt.pctUsed!).toBeGreaterThan(90);
    expect(asBig.pctUsed!).toBeLessThan(0.001);
  });

  it('reports an unreadable sequence as unreadable, with no percentage at all', () => {
    const { sequences: s } = toSequences([row({ readable: false, last_value: null })]);
    expect(s[0]!.readable).toBe(false);
    expect(s[0]!.lastValue).toBeNull();
    // Never 0: "we could not look" and "it is empty" are opposite answers.
    expect(s[0]!.pctUsed).toBeNull();
  });

  it('keeps a genuine zero, which is a sequence nobody has drawn from', () => {
    const { sequences: s } = toSequences([row({ last_value: '0' })]);
    expect(s[0]!.lastValue).toBe(0);
    expect(s[0]!.pctUsed).toBe(0);
  });

  it('carries a null table and column for a sequence no column owns', () => {
    const { sequences: s } = toSequences([
      row({ table_name: null, column_name: null, column_type: null }),
    ]);
    expect(s[0]!.table).toBeNull();
    expect(s[0]!.columnType).toBeNull();
  });

  /**
   * Unreadable rows have no percentage and sort last, so they are the first
   * rows a LIMIT discards. Counting the returned page would report 0
   * unreadable when every one of them was cut.
   */
  it('reports the database-wide unreadable count, not the count on this page', () => {
    expect(toSequences([row({ unreadable: 7, total: 40 })]).unreadable).toBe(7);
  });

  it('reads truncation from the pre-LIMIT total', () => {
    expect(toSequences([row({ total: 40 })])).toMatchObject({ total: 40, truncated: true });
  });

  it('converts the worst ratio to a percentage', () => {
    expect(toSequences([row({ worst_pct: '0.9313225741' })]).worstPctUsed!.toFixed(2))
      .toBe('93.13');
  });

  it('reports no worst ratio at all when nothing was readable', () => {
    expect(toSequences([row({ worst_pct: null })]).worstPctUsed).toBeNull();
  });
});

describe('the sequences verdict', () => {
  const t = () => sequences.thresholds!;
  const data = (worstPctUsed: number | null) => ({
    sequences: [], total: 0, truncated: false, unreadable: 0, worstPctUsed,
  });

  /** 1,932,735,283 / 2,147,483,647 is 90.00000003%; one less is 89.99999999%. */
  it('warns one value above the threshold', () => {
    expect(sequences.verdict!(data(1932735283 / 2147483647 * 100), t()).level).toBe('warn');
  });

  it('is ok one value below the threshold', () => {
    expect(sequences.verdict!(data(1932735282 / 2147483647 * 100), t()).level).toBe('ok');
  });

  it('warns at exactly the threshold', () => {
    expect(sequences.verdict!(data(90), t()).level).toBe('warn');
  });

  it('names the percentage in the note', () => {
    expect(sequences.verdict!(data(93.132), t()).note).toContain('93.13');
  });

  /**
   * `Verdict` has no third state, so this returns `ok`: the absence of a
   * finding, not a claim of health. `data.unreadable` is what tells the
   * operator about the blind spot.
   */
  it('is ok when there was no readable sequence to judge', () => {
    expect(sequences.verdict!(data(null), t())).toEqual({ level: 'ok' });
  });

  /** The threshold lookup must not use a non-null assertion on `find`. */
  it('does not escalate when it was given no warn threshold', () => {
    expect(sequences.verdict!(data(99), [])).toEqual({ level: 'ok' });
  });
});

describe('the sequences contract', () => {
  it('is a keep-up captured check', () => {
    expect(sequences.gate).toBe('keep-up');
    expect(sequences.class).toBe('captured');
    expect(sequences.timeoutMs).toBe(10_000);
  });

  it("adopts pgHero's 90 percent, measured against the column type", () => {
    const warn = sequences.thresholds!.find((x) => x.level === 'warn')!;
    expect(warn.value).toBe(90);
    expect(warn.unit).toBe('percent');
    expect(warn.because).toContain('sequence_danger');
    expect(warn.because).toContain('column type');
  });

  /**
   * `regnamespace` parses identifier syntax, so one schema named
   * "Weird Schema" anywhere in the database fails the whole check.
   */
  it('never casts to regnamespace or regclass', () => {
    const text = (sequences.sql as (o: object) => { text: string })({}).text;
    expect(text).not.toContain('regnamespace');
    expect(text).not.toMatch(/::regclass::text/);
  });

  it("asks for SELECT or USAGE, because Postgres accepts either", () => {
    const text = (sequences.sql as (o: object) => { text: string })({}).text;
    expect(text).toContain("'SELECT,USAGE'");
  });
});
