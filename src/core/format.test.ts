import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { formatDuration, truncateQuery } from './format.js';

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(863)).toBe('14m 23s');
    expect(formatDuration(7_400)).toBe('2h 3m');
  });

  it('renders unknown and clock-skewed durations as unknown, never as zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});

/**
 * `truncateQuery` is the chokepoint every view routes query text through, so it
 * is where redaction has to live (deep-review I3): before this, the two FILE
 * sinks (snapshots, audit log) were clean while every TUI rendered
 * `pg_stat_activity.query` verbatim on screen.
 */
describe('truncateQuery', () => {
  it('collapses whitespace and truncates', () => {
    expect(truncateQuery('SELECT\n  1\n  FROM users')).toBe('SELECT 1 FROM users');
    expect(truncateQuery('SELECT 1 FROM users', 10)).toBe('SELECT 1 …');
  });

  it('redacts a password caught in flight in a SQL statement', () => {
    const out = truncateQuery("ALTER USER app PASSWORD 'hunter2'", 200);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('ALTER USER app PASSWORD ***');
  });

  it('redacts a connection string embedded in a query (dblink, fdw, COPY … PROGRAM)', () => {
    expect(truncateQuery("SELECT dblink_connect('postgres://u:hunter2@h/db')", 200)).not.toContain('hunter2');
  });

  it('redacts BEFORE truncating, so a clipped query cannot leak the head of a secret', () => {
    // 'hunter2' sits astride the cut: truncate-then-redact would leave "hunt…"
    // on screen with no pattern left to match.
    const q = "ALTER USER app PASSWORD 'hunter2'";
    expect(truncateQuery(q, q.indexOf('hunter2') + 5)).not.toContain('hunt');
  });

  it('leaves an ordinary query untouched', () => {
    expect(truncateQuery('UPDATE orders SET total = 1')).toBe('UPDATE orders SET total = 1');
  });

  it('reports a missing query rather than an empty cell', () => {
    expect(truncateQuery(null)).toBe('<no query>');
  });

  it('budgets in display columns, not UTF-16 code units (CJK)', () => {
    // A fullwidth character is one code unit but two display columns, so the
    // old `.slice(0, max - 1)` returned up to 2x `max` columns. `sessions`
    // passes the terminal's own width here (Sessions.tsx), so an over-wide
    // line wraps and grows the detail panel under the table.
    const q = 'SELECT * FROM 顧客テーブル WHERE 名前 = 1'; // 41 display columns
    expect(stringWidth(truncateQuery(q, 20))).toBeLessThanOrEqual(20);
    expect(truncateQuery(q, 20)).toContain('…');
  });

  it('never splits an emoji surrogate pair when truncating', () => {
    // `.slice` cuts 🔥 in half and emits a lone, unpaired UTF-16 code unit.
    const out = truncateQuery("SELECT '🔥🔥🔥🔥🔥🔥' FROM t", 10);
    expect(stringWidth(out)).toBeLessThanOrEqual(10);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('emits exactly one ellipsis — cli-truncate appends its own', () => {
    // Guards the double-ellipsis mistake: `${cliTruncate(s, max - 1)}…`.
    expect([...truncateQuery('SELECT 1 FROM users', 10)].filter((c) => c === '…')).toHaveLength(1);
  });

  /**
   * `cli-truncate@4` does not honour its own width cap when the cut lands on a
   * wide or astral grapheme it doesn't classify as fullwidth: measured,
   * `cliTruncate('🔥🔥🔥', 4)` returns `'🔥🔥🔥…'` — 7 display columns, 3 over the
   * requested cap — and `cliTruncate('a🔥b', 3)` returns `'a🔥…'`, 4 columns.
   * `truncateQuery` routes through `fitToWidth`, which steps the cap down
   * until the *actual* rendered width is within budget. If it regressed to a
   * bare `cliTruncate` call, every one of these would fail.
   */
  it('never renders wider than the requested budget, even when the cut lands on an emoji', () => {
    expect(stringWidth(truncateQuery('a🔥b', 3))).toBeLessThanOrEqual(3);
    expect(stringWidth(truncateQuery('🔥🔥🔥', 4))).toBeLessThanOrEqual(4);
  });

  it('still fits CJK text at its already-correct width (pin, no regression)', () => {
    const out = truncateQuery('日本語です', 5);
    expect(stringWidth(out)).toBeLessThanOrEqual(5);
    expect(out).toBe('日本…');
  });

  it('terminates and stays within budget when the very first grapheme is wider than the cap', () => {
    const out = truncateQuery('🔥', 1);
    expect(stringWidth(out)).toBeLessThanOrEqual(1);
    expect(out).toBe('…');
  });

  it('leaves plain ASCII untouched by the width-fitting step, at several widths', () => {
    expect(truncateQuery('hello world', 20)).toBe('hello world');
    expect(truncateQuery('hello world', 8)).toBe('hello w…');
    expect(truncateQuery('hello world', 1)).toBe('…');
  });
});
