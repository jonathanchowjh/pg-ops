import { describe, expect, it } from 'vitest';
import { foldFrom, foldOurs, isOurs } from '@/lib/fold';

describe('isOurs', () => {
  it('recognises the store schema and nothing that merely starts like it', () => {
    expect(isOurs('pgops.query_stats')).toBe(true);
    // A user schema called `pgopsy` is somebody else's, and a table called
    // `pgops` in the public schema is too.
    expect(isOurs('pgopsy.things')).toBe(false);
    expect(isOurs('public.pgops')).toBe(false);
  });
});

describe('foldOurs', () => {
  const rows = [
    { name: 'public.orders' },
    { name: 'pgops.query_stats' },
    { name: 'pgops.check_results' },
  ];

  it('hides its own rows and counts them', () => {
    const { shown, mine } = foldOurs(rows, (r) => r.name, false);
    expect(shown.map((r) => r.name)).toEqual(['public.orders']);
    expect(mine).toBe(2);
  });

  /**
   * The count is stated whether or not the rows are hidden. An operator who
   * has clicked through needs to know which of the rows in front of them
   * belong to the console.
   */
  it('still counts them when they are shown', () => {
    const { shown, mine } = foldOurs(rows, (r) => r.name, true);
    expect(shown).toHaveLength(3);
    expect(mine).toBe(2);
  });

  it('reads the subject the caller names, not a field it guesses', () => {
    const usage = [{ index: 'pgops.idx', table: 'public.orders' }];
    // An index-usage row is ABOUT its table, even though it names an index.
    expect(foldOurs(usage, (r) => r.table, false).mine).toBe(0);
    expect(foldOurs(usage, (r) => r.index, false).mine).toBe(1);
  });
});

describe('foldFrom', () => {
  it('flips the fold and carries every other parameter with it', () => {
    const folded = foldFrom('/db/prod/sessions', { limit: '200' });
    expect(folded.show).toBe(false);
    expect(folded.href.query).toEqual({ limit: '200', pgops: 'show' });

    const shown = foldFrom('/db/prod/sessions', { limit: '200', pgops: 'show' });
    expect(shown.show).toBe(true);
    // The way back drops `pgops` and keeps the limit — an operator who set a
    // limit does not lose it by looking at the console's own rows.
    expect(shown.href.query).toEqual({ limit: '200' });
  });

  it('drops parameters that were never set rather than sending empties', () => {
    expect(foldFrom('/db/prod/sessions', { limit: undefined, sort: '' }).href.query)
      .toEqual({ pgops: 'show' });
  });
});
