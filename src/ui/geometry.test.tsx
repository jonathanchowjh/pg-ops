import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { RootBlocker } from '../commands/locks/chain.js';
import { LockChain } from '../commands/locks/LockChain.js';
import type { SessionRow } from '../commands/sessions/query.js';
import { Sessions } from '../commands/sessions/Sessions.js';
import type { QueryRow } from '../commands/top/stats.js';
import { Top } from '../commands/top/Top.js';
import { Table } from './Table.js';
import type { Column } from './table-layout.js';

/**
 * The geometry invariant, stated once for every view that renders a `Table`.
 *
 * `Table` sets `width` on its own root `<Box>`, so Ink *wraps* text at that
 * width rather than letting a line exceed it — a row that does not fit never
 * shows up as a too-wide line, it shows up as an extra line. A 2×50-column
 * undroppable set (103 columns including the gutter) rendered at width 80
 * comes out as five wrapped lines of [54, 52, 50, 52, 50] — every one of them
 * <= 80, but two rows' worth of extra lines. So the assertion that matters is
 * "narrowing the terminal does not change the line count," not "no line
 * exceeds the width." Part 2 below proves this gate can actually fail.
 *
 * Self-calibrating rather than hand-computed: the baseline is measured by
 * rendering very wide, where nothing can wrap, and every other width is
 * compared against it. When the shell phase adds a view, add a case to
 * `views` below. That is the point of the file.
 */

const lineCount = (el: ReactElement) => (render(el).lastFrame() ?? '').split('\n').length;

// Wider than any column set here can grow to (sessions' and top's flex query
// columns cap out well under this), so nothing can wrap — the baseline.
const WIDE = 400;
const WIDTHS = [80, 100, 120, 160];

/**
 * Deliberately pathological: every cell at or beyond its column's width.
 * `state` overflows the 22-wide state column, `user`/`app` overflow the
 * 20-wide `who` column, and `query` overflows every flex column's floor at
 * every tested width.
 */
const sessionRow = (pid: number, over: Partial<SessionRow> = {}): SessionRow => ({
  pid,
  state: 'idle in transaction (aborted)',
  user: 'a-fairly-long-username',
  app: 'PostgreSQL JDBC Driver',
  clientAddr: '10.0.0.1',
  backendStart: '2026-08-20 09:00:00+00',
  inStateSecs: 123_456_789,
  runningSecs: 123_456_789,
  query: 'SELECT '.repeat(80),
  ...over,
});

/**
 * Deliberately pathological, same recipe as `sessionRow`: `user@app` overflows
 * the 20-wide `who` column and `heldMode` overflows the 16-wide `mode`
 * column at every tested width. `query` never appears in a table cell (it's
 * rendered in `LockChain`'s detail block, below the table, only for the
 * selected root) so it does not need to be pathological here — see the
 * `SELECTED_INDEX` override below and the comment on `sessions` above for why
 * it is the opposite: kept SHORT.
 */
const rootBlocker = (pid: number, over: Partial<RootBlocker> = {}): RootBlocker => ({
  pid,
  user: 'a-fairly-long-username',
  app: 'PostgreSQL JDBC Driver',
  query: 'SELECT '.repeat(80),
  heldMode: 'AccessExclusiveLock (unusually verbose)',
  heldForSecs: 863,
  state: 'idle in transaction',
  backendStart: null,
  totalWaiters: 2,
  waiters: [
    { pid: pid + 1, user: 'u', app: 'web-api', query: 'q', waitingMode: 'ShareLock', table: 'users', waitingForSecs: 5, waiters: [], cycle: false, state: 'active', backendStart: null },
  ],
  ...over,
});

const queryRow = (i: number): QueryRow => ({
  queryid: String(i),
  query: 'SELECT '.repeat(80),
  calls: 999_999_999,
  totalMs: 999_999_999,
  meanMs: 99_999.999,
  stddevMs: 1,
  rows: 1,
  sharedBlksHit: 1,
  sharedBlksRead: 1,
  cacheHitPct: 42,
});

// Mid-list, so the window scrolls off both ends and both `↑`/`↓` indicators
// render — the widest chrome each view's header line can carry.
const SELECTED_INDEX = 100;

/**
 * `Sessions` renders a detail panel BELOW the table (`Sessions.tsx`'s
 * `selected` block) that is not inside `Table`'s own explicit-width `Box`.
 * `ink-testing-library`'s stdout stub reports a fixed 100 columns with no
 * setter (`useTerminalSize.ts`), so an un-boxed `<Text>` always lays out
 * against that physical 100, no matter what `width` prop this test passes in.
 * The table region is immune (it sets its own width and is what this gate
 * exists to check), but the detail line under it is truncated using the
 * *logical* width — at width 400 that truncates to ~397 characters, which
 * then wraps against the physical 100-column box, inflating the line count
 * for reasons that have nothing to do with the table. That is a real gap in
 * `Sessions.tsx` (the detail `Box` should carry an explicit `width` the way
 * `Table` does), but it is out of this task's scope-fenced production files,
 * and it is not what this gate is chartered to catch. So the selected row
 * alone carries a short, realistic query — every other row stays pathological
 * — which keeps the detail line short enough to never wrap at any width this
 * file tests, isolating the assertion to the table geometry it is meant to
 * cover.
 */
const sessions = Array.from({ length: 200 }, (_, i) =>
  sessionRow(1000 + i, i === SELECTED_INDEX ? { query: 'SELECT id FROM widgets WHERE id = 1' } : {}),
);
const queries = Array.from({ length: 200 }, (_, i) => queryRow(i));

// Same trap as `sessions` above, same fix: `LockChain`'s detail block below
// the table is not inside `Table`'s own explicit-width `Box`, so it lays out
// against `ink-testing-library`'s fixed physical 100-column stdout no matter
// what logical `width` this test passes. Only the query line scales with
// `width` (`LockChain.tsx`'s `detailWidth`), so only the selected root needs
// a short, realistic query to keep that line short enough to never wrap at
// any tested width — every other root stays pathological.
//
// Pids are 7 digits (`kernel.pid_max` defaults to 4194304, so these are
// ordinary), saturating the 7-wide `pid` column — review round 1 (R1-4)
// found the previous 4-digit pids left slack in the one column that turned
// out to have a real bug (a 2-column `⚠` marker eating into a 7-wide cell).
const roots = Array.from({ length: 200 }, (_, i) =>
  rootBlocker(1_000_000 + i, i === SELECTED_INDEX ? { query: 'UPDATE accounts SET balance = balance - 1' } : {}),
);

const views = [
  {
    name: 'sessions',
    at: (w: number) => <Sessions rows={sessions} selectedIndex={SELECTED_INDEX} width={w} maxLines={18} />,
  },
  {
    name: 'top',
    at: (w: number) => <Top rows={queries} sort="total" selectedIndex={SELECTED_INDEX} width={w} maxLines={18} />,
  },
  {
    name: 'locks',
    at: (w: number) => <LockChain roots={roots} selectedIndex={SELECTED_INDEX} width={w} maxLines={18} />,
  },
];

describe('terminal geometry', () => {
  for (const view of views) {
    it(`${view.name} renders the same number of lines at every width`, () => {
      const baseline = lineCount(view.at(WIDE));
      for (const width of WIDTHS) {
        expect(lineCount(view.at(width))).toBe(baseline);
      }
    });
  }

  // Part 2 — proves the gate above can actually fail. A gate nobody has seen
  // fail is not known to work.
  it('the gate detects wrapping — an over-wide column set costs extra lines', () => {
    // Two 50-wide columns plus the gutter is 103 columns; at width 80 Ink
    // must wrap each row. Neither column flexes or drops, so `solveColumns`
    // cannot shrink them to fit — the row is left over-wide on purpose
    // (`table-layout.ts`'s documented behaviour), and `Table`'s own
    // explicit-width `Box` then hard-wraps it. If this ever stops being true,
    // the gate above is vacuous.
    const overWide: Column<{ n: number }>[] = [
      { key: 'a', header: 'a', width: 50, value: (r) => `A${r.n}`.repeat(50) },
      { key: 'b', header: 'b', width: 50, value: (r) => `B${r.n}`.repeat(50) },
    ];
    const rows = Array.from({ length: 3 }, (_, i) => ({ n: i }));
    const table = (w: number) => (
      <Table columns={overWide} rows={rows} selectedIndex={0} maxLines={20} width={w} rowKey={(r) => String(r.n)} />
    );

    expect(lineCount(table(80))).toBeGreaterThan(lineCount(table(WIDE)));
  });
});
