import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Top } from './Top.js';
import type { QueryRow } from './stats.js';

const row = (n: number, over: Partial<QueryRow> = {}): QueryRow => ({
  queryid: String(n),
  query: `SELECT ${n} FROM orders`,
  calls: 120,
  totalMs: 5400,
  meanMs: 45,
  stddevMs: 10,
  rows: 120,
  sharedBlksHit: 900,
  sharedBlksRead: 100,
  cacheHitPct: 90,
  ...over,
});

describe('Top', () => {
  it('marks the sorted column in the header', () => {
    const { lastFrame } = render(<Top rows={[row(1)]} sort="mean" selectedIndex={0} />);
    expect(lastFrame()).toContain('▼mean ms');
  });

  it('windows a long query list', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    const { lastFrame } = render(<Top rows={rows} sort="total" selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('more');
    // A Table that rendered all 60 rows (plus a bogus overflow line) would
    // also pass the assertion above — this only fails for the real bug. Sat on
    // row 59, which is 38 rows past the edge and so survives most off-by-ones;
    // moved to the actual boundary, the way sessions' twin (pid 1021) was. No
    // `maxLines` override, so Table falls through to the terminal: the harness
    // reports no stdout.rows, so useTerminalSize's fallback (24) applies and
    // budgetRows(24, 60) = 21. The window is [0, 21); row 21 is the first row
    // just past it, and the one an off-by-one would leak.
    // Pin the boundary from both sides: `not.toContain('SELECT 21')` alone
    // also passes if the window shrank (e.g. budgetRows off-by-one the other
    // way), which would silently drop row 20 too.
    expect(frame).toContain('SELECT 20');
    expect(frame).not.toContain('SELECT 21');
  });

  it('never renders a password caught in flight in pg_stat_statements.query', () => {
    // Mirrors sessions/Sessions.test.tsx:98 — this table gets screenshotted
    // into Slack too, and its query cell goes through cellQuery (which
    // delegates to the same truncateQuery/redactSecrets pipeline) rather than
    // a bare slice, so the same secret must never reach the frame here either.
    const withSecret = { ...row(1), query: "ALTER USER app PASSWORD 'hunter2'" };
    const { lastFrame } = render(<Top rows={[withSecret]} sort="total" selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('hunter2');
    expect(frame).toContain('ALTER USER app PASSWORD ***');
  });

  it('explains an empty list differently when a filter is active', () => {
    const { lastFrame: noFilter } = render(<Top rows={[]} sort="total" selectedIndex={0} />);
    expect(noFilter()).toContain('pg_stat_statements');

    const { lastFrame: filtered } = render(<Top rows={[]} sort="total" selectedIndex={0} filter="orders" />);
    expect(filtered()).toContain('No queries match');
  });

  it('fits an 80-column terminal without wrapping any row', () => {
    // A wrapped row never shows up as a too-wide line — `Table` sets `width`
    // on its own root `Box`, so Ink wraps the overflow into an extra line
    // instead (see `src/ui/geometry.test.tsx`). So the signal that a row
    // wrapped is an inflated line count, not a line exceeding 80 columns:
    // that assertion could never fail, since Ink enforces it structurally.
    // Compare against a render wide enough that nothing can wrap.
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const lineCount = (width: number) =>
      (render(<Top rows={rows} sort="total" selectedIndex={0} width={width} maxLines={20} />).lastFrame() ?? '')
        .split('\n').length;
    expect(lineCount(80)).toBe(lineCount(400));
  });

  it('keeps calls and cache at 80 columns, and drops both together on a narrow terminal', () => {
    // The old assertion (`not.toContain('+1')`) protects nothing: if `drop`
    // were removed from `calls`/`cache` entirely, no `+N` ever renders and it
    // still passes. It also can't see a drop-*both* bug (`+2`) — it only ever
    // looked for `+1`. Assert the actual property, in both directions: wide
    // enough that nothing drops, and narrow enough that both numeric columns
    // do, and say so.
    const rows = [row(1)];

    const wide = render(<Top rows={rows} sort="total" selectedIndex={0} width={80} maxLines={20} />).lastFrame() ?? '';
    expect(wide).toContain('calls');
    expect(wide).toContain('cache');
    expect(wide).not.toMatch(/\+\d/);

    // Narrow enough that even after dropping `calls` (drop: 3) alone still
    // doesn't fit; `cache` (drop: 2) goes too, leaving `+2` in the header.
    const narrow = render(<Top rows={rows} sort="total" selectedIndex={0} width={40} maxLines={20} />).lastFrame() ?? '';
    expect(narrow).not.toContain('calls');
    expect(narrow).not.toContain('cache');
    expect(narrow).toContain('+2');
  });
});
