import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Sessions } from './Sessions.js';
import type { SessionRow } from './query.js';

const row = (pid: number, over: Partial<SessionRow> = {}): SessionRow => ({
  pid,
  state: 'active',
  user: 'app',
  app: 'web',
  clientAddr: null,
  backendStart: '2026-07-12 10:00:00+00',
  inStateSecs: 5,
  runningSecs: 5,
  query: 'SELECT 1',
  ...over,
});

describe('Sessions', () => {
  it('windows a long session list rather than rendering every row', () => {
    const many = Array.from({ length: 60 }, (_, i) => row(1000 + i));
    const { lastFrame } = render(<Sessions rows={many} selectedIndex={0} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1000');
    // No `maxLines` override here, so Table falls through to the terminal:
    // the test harness reports no stdout.rows, so useTerminalSize's fallback
    // (24) applies. budgetRows(24, 60) = max(1, 24 - 3) = 21, so the window
    // is [0, 21); pid 1021 (row index 21) is the first row just past it —
    // the boundary row, and the one an off-by-one would leak.
    expect(frame).not.toContain('1021');
    expect(frame).toContain('more');
  });

  it('shows the selected row detail below the table', () => {
    const { lastFrame } = render(<Sessions rows={[row(4711)]} selectedIndex={0} />);
    expect(lastFrame()).toContain('session began');
  });

  it('renders the empty message with no rows', () => {
    const { lastFrame } = render(<Sessions rows={[]} selectedIndex={0} />);
    expect(lastFrame()).toContain('No client sessions.');
  });

  it('costs exactly 3 chrome lines below the table — the number the container budgets', () => {
    /*
     * Was "does not wrap rows into a blank line (finding 1)". BOTH of its
     * assertions had gone inert, not just the `line.length <= 100` one the
     * review flagged — verified by mutation, by restoring the final column's
     * padding and watching this test still pass. Its premise ("the padded
     * widths sum to 122, wider than the terminal") predates `solveColumns`:
     * the flex `query` column now absorbs whatever slack is left, so a solved
     * sessions row fills the terminal *exactly* at every width where `query`
     * is above its floor, padded or not. Finding 1 is unreachable through this
     * view. Its live guard is `ui/Table.test.tsx`'s version of this test, whose
     * column set has no flex column and so genuinely overflows — that one does
     * fail when the padding comes back.
     *
     * What is left worth pinning here is the frame's shape, so that is what it
     * now asserts: one line per row, and a detail panel costing exactly the 3
     * lines `sessions/index.tsx`'s `CHROME_LINES = 6` budgets for it (a blank
     * line plus 2). An exact count rather than a comparison against a wider
     * render — a comparison cancels out, since anything that overflows here
     * overflows by the same amount at any width — and it subsumes the old
     * blank-line assertion, because a wrapped remainder is an extra line
     * whether or not it is blank.
     */
    const rows = [row(1), row(2), row(3)];
    const frame = render(<Sessions rows={rows} selectedIndex={0} />).lastFrame() ?? '';
    // header + 3 rows + the blank line marginTop={1} puts before the detail
    // panel + the panel's 2 lines (client/session began, then the query).
    expect(frame.split('\n')).toHaveLength(7);
  });

  it('fits an 80-column terminal without wrapping any row', () => {
    // A wrapped row never shows up as a too-wide line — `Table` sets `width`
    // on its own root `Box`, so Ink wraps the overflow into an extra line
    // instead (see `src/ui/geometry.test.tsx`). So the signal that a row
    // wrapped is an inflated line count, not a line exceeding 80 columns:
    // that assertion could never fail, since Ink enforces it structurally.
    // Compare against a render wide enough that nothing can wrap.
    const rows = Array.from({ length: 50 }, (_, i) => row(100 + i));
    const lineCount = (width: number) =>
      (render(<Sessions rows={rows} selectedIndex={0} width={width} maxLines={20} />).lastFrame() ?? '').split('\n')
        .length;
    expect(lineCount(80)).toBe(lineCount(400));
  });

  it('drops user@app before it starves the query column', () => {
    const rows = [row(42, { user: 'alice', app: 'checkout' })];
    const narrow = render(<Sessions rows={rows} selectedIndex={0} width={80} maxLines={20} />);
    expect(narrow.lastFrame()).not.toContain('alice@checkout');
    const wide = render(<Sessions rows={rows} selectedIndex={0} width={130} maxLines={20} />);
    expect(wide.lastFrame()).toContain('alice@checkout');
  });
});
