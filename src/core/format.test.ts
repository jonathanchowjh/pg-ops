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
});
