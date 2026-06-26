import { describe, expect, it } from 'vitest';
import { queryStatsToMarkdown } from './render.js';
import type { QueryRow } from './stats.js';

/** Build a prepared QueryRow with defaults; override what the test cares about. */
function row(over: Partial<QueryRow> = {}): QueryRow {
  return {
    queryid: '1',
    query: 'SELECT 1',
    calls: 1,
    totalMs: 100,
    meanMs: 100,
    stddevMs: 0,
    rows: 1,
    sharedBlksHit: 90,
    sharedBlksRead: 10,
    cacheHitPct: 90,
    ...over,
  };
}

describe('queryStatsToMarkdown', () => {
  it('shows a placeholder when there are no rows', () => {
    expect(queryStatsToMarkdown([], 'total')).toContain('No query statistics');
  });

  it('titles the section by the active sort mode', () => {
    expect(queryStatsToMarkdown([row()], 'total')).toContain('total time');
    expect(queryStatsToMarkdown([row()], 'mean')).toContain('mean time');
    expect(queryStatsToMarkdown([row()], 'calls')).toContain('calls');
    expect(queryStatsToMarkdown([row()], 'cache')).toContain('cache');
  });

  it('formats total as a whole number, mean to two decimals, and cache as a percent', () => {
    const md = queryStatsToMarkdown([row({ totalMs: 445.7, meanMs: 8.926, calls: 50, cacheHitPct: 78.4 })], 'total');
    expect(md).toContain('446'); // total rounded
    expect(md).toContain('8.93'); // mean to 2dp
    expect(md).toContain('50'); // calls
    expect(md).toContain('78%'); // cache rounded with unit
  });

  it('renders an em dash when cache hit is null', () => {
    const md = queryStatsToMarkdown([row({ cacheHitPct: null })], 'total');
    expect(md).toContain('—');
  });

  it('collapses whitespace and truncates a long query', () => {
    const long = 'SELECT ' + 'x,\n  '.repeat(50) + 'y FROM t';
    const md = queryStatsToMarkdown([row({ query: long })], 'total');
    expect(md).toContain('…');
    expect(md).not.toContain('\n  '); // newlines/indentation collapsed
  });

  it('escapes pipe characters so the markdown table is not broken by `||`', () => {
    // A real hazard: `SELECT a || b` contains a pipe that would split the cell.
    const md = queryStatsToMarkdown([row({ query: 'SELECT a || b AS c' })], 'total');
    expect(md).toContain('\\|\\|');
  });
});
