import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Table } from './Table.js';
import type { Column } from './table-layout.js';

interface Row {
  pid: number;
  state: string;
}

const COLUMNS: Column<Row>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid) },
  { key: 'state', header: 'state', width: 10, value: (r) => r.state },
];

const rows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ pid: 100 + i, state: `state${i}` }));

describe('Table', () => {
  it('renders the empty message when there are no rows', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={[]} selectedIndex={0} maxLines={8} rowKey={(r) => String(r.pid)} empty="No sessions." />,
    );
    expect(lastFrame()).toContain('No sessions.');
  });

  it('renders headers and every row when they fit', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(3)} selectedIndex={0} maxLines={8} rowKey={(r) => String(r.pid)} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pid');
    expect(frame).toContain('100');
    expect(frame).toContain('102');
    expect(frame).not.toContain('more');
  });

  it('windows a long list and reports how many rows are hidden', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(100)} selectedIndex={0} maxLines={8} rowKey={(r) => String(r.pid)} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('100'); // first row visible
    // The window is [0, 5); row index 5 (pid 105, state5) is the first row
    // just past it — the boundary row, and the one an off-by-one would leak.
    expect(frame).not.toContain('state5');
    expect(frame).toContain('↓ 95 more');
  });

  it('marks the selected row', () => {
    const { lastFrame } = render(
      <Table columns={COLUMNS} rows={rows(3)} selectedIndex={1} maxLines={8} rowKey={(r) => String(r.pid)} />,
    );
    expect(lastFrame()).toContain('▸');
  });

  it('scrolls minimally across rerenders instead of jumping (prevStart)', () => {
    // prevStart — the ref-based minimal-scroll state — is the only new
    // stateful logic Table adds; it's untested without a rerender.
    const { lastFrame, rerender } = render(
      <Table columns={COLUMNS} rows={rows(20)} selectedIndex={0} maxLines={8} rowKey={(r) => String(r.pid)} />,
    );
    expect(lastFrame()).not.toContain('↑'); // window starts at [0, 5): nothing hidden above yet

    rerender(<Table columns={COLUMNS} rows={rows(20)} selectedIndex={5} maxLines={8} rowKey={(r) => String(r.pid)} />);
    // Selection stepped exactly one row past the bottom edge — the window
    // should scroll the minimum needed (to [1, 6)), not jump or re-centre.
    expect(lastFrame()).toContain('↑ 1 more');

    rerender(<Table columns={COLUMNS} rows={rows(20)} selectedIndex={4} maxLines={8} rowKey={(r) => String(r.pid)} />);
    // Selection stepped back to inside the window ([1, 6) still contains 4) —
    // prevStart must hold the window exactly where it was, not snap it back.
    expect(lastFrame()).toContain('↑ 1 more');
  });

  it('does not pad the final column, so short rows never wrap into a blank line', () => {
    // Mirrors sessions'/top's real column widths closely enough to matter: the
    // ink-testing-library terminal is a fixed 100 columns, and the padded sum
    // of these widths (2 + 30 + 1 + 30 + 1 + 50 = 114) exceeds it — so if the
    // final column were still padded, every row would wrap into a second,
    // blank line (finding 1).
    interface WideRow {
      id: number;
      a: string;
      b: string;
    }
    const wideColumns: Column<WideRow>[] = [
      { key: 'a', header: 'a', width: 30, value: (r) => r.a },
      { key: 'b', header: 'b', width: 30, value: (r) => r.b },
      { key: 'c', header: 'c', width: 50, value: (r) => r.a },
    ];
    const wideRows: WideRow[] = [
      { id: 1, a: 'short', b: 'text' },
      { id: 2, a: 'also-short', b: 'more' },
      { id: 3, a: 'x', b: 'y' },
    ];
    const linesAt = (width?: number) =>
      (
        render(
          <Table columns={wideColumns} rows={wideRows} selectedIndex={0} maxLines={8} width={width}
                 rowKey={(r) => String(r.id)} />,
        ).lastFrame() ?? ''
      ).split('\n');

    const lines = linesAt(); // no width: the harness's fixed 100-column terminal
    expect(lines.some((line) => line.trim() === '')).toBe(false);
    // The `line.length <= 100` this used to assert cannot fail: `Table` sets
    // `width` on its own root `Box`, so Ink clamps every line to it. A padded
    // final column shows up as an extra *wrapped* line, not a long one — so
    // compare the line count against a width nothing can wrap at.
    expect(lines.length).toBe(linesAt(400).length);
  });
});

describe('Table geometry', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ n: i }));
  const columns: Column<{ n: number }>[] = [
    { key: 'n', header: 'n', width: 6, align: 'right', value: (r) => String(r.n) },
    { key: 'who', header: 'who', width: 20, drop: 2, value: () => 'someone@someapp' },
    { key: 'text', header: 'text', width: 60, flex: true, min: 20, value: () => 'x'.repeat(200) },
  ];

  const lines = (frame: string | undefined) => (frame ?? '').split('\n');

  it('wraps no row at 80 columns — the same line count as an unconstrained render', () => {
    // The assertion this replaces (`stringWidth(line) <= 80`) could never fail:
    // `Table` sets `width` on its own root `Box`, so Ink clamps every line to
    // it. A row that does not fit costs an extra *wrapped* line instead — see
    // `src/ui/geometry.test.tsx`, which is where that comparison is proven to
    // be able to fail. Baseline is a width wide enough that nothing can wrap.
    const lineCount = (width: number) =>
      lines(
        render(
          <Table columns={columns} rows={rows} selectedIndex={0} width={width} maxLines={12}
                 rowKey={(r) => String(r.n)} />,
        ).lastFrame(),
      ).length;
    expect(lineCount(80)).toBe(lineCount(400));
  });

  it('occupies exactly its budget, less the reserved ↑ line', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={120} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    // 11, not 12: `budgetRows(12, 200)` reserves 3 chrome lines (header, ↑, ↓)
    // and hands back 9 data rows, but the selection is at index 0 so nothing is
    // hidden above and the reserved ↑ line goes unrendered. That line stays
    // reserved on purpose — releasing it would change the row count as the
    // selection moves and make the window jitter (see `budgetRows`).
    expect(lines(lastFrame()).length).toBe(11);
  });

  it('names how many columns it dropped instead of hiding them silently', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={40} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    expect(lastFrame()).toContain('+1');
    expect(lastFrame()).not.toContain('someone@someapp');
  });

  it('keeps a dropped column when the terminal is wide enough for it', () => {
    const { lastFrame } = render(
      <Table columns={columns} rows={rows} selectedIndex={0} width={140} maxLines={12}
             rowKey={(r) => String(r.n)} />,
    );
    expect(lastFrame()).toContain('someone@someapp');
    expect(lastFrame()).not.toContain('+1');
  });

  it('clamps a degenerate width to MIN_WIDTH instead of letting the gutter and header hint cascade (finding 2)', () => {
    // Unclamped, a width this small blows the line budget: the controller's
    // probe measured width=3 rendering 20 lines against maxLines=8, because the
    // gutter and the `+N` dropped-column hint wrap. Self-calibrating rather
    // than a hand-computed line count: render at the clamp floor (20) and at
    // the degenerate width (3) and assert they produce the exact same output —
    // proof the clamp is actually engaging, not just coincidentally in range.
    const renderAt = (width: number) => {
      const { lastFrame } = render(
        <Table columns={columns} rows={rows} selectedIndex={0} width={width} maxLines={8}
               rowKey={(r) => String(r.n)} />,
      );
      return lastFrame();
    };
    const at20 = renderAt(20);
    const at3 = renderAt(3);
    expect(lines(at3).length).toBe(lines(at20).length);
    expect(at3).toBe(at20);
  });
});

/**
 * `formatCell`'s over-wide-truncation bug is invisible in isolation once you
 * only assert `stringWidth(result) <= width` on the cell itself — you have to
 * render a full row to see what an over-wide cell actually does to its
 * neighbour: shove it out of alignment. This renders through the real `Table`
 * component (not a mock) so the assertion is end-to-end, the same way the bug
 * was originally found (deep-review, emoji inside `pg_stat_activity.query`).
 */
describe('formatCell alignment through Table (regression: cli-truncate over-wide cut)', () => {
  interface AlignmentRow {
    first: string;
    second: string;
  }

  // First column's width (3) is smaller than 'a🔥b's display width (4), so it
  // must truncate. Second column is fixed-width and un-droppable, so any
  // misalignment is entirely attributable to the first column's truncation.
  const ALIGNMENT_COLUMNS: Column<AlignmentRow>[] = [
    { key: 'first', header: 'first', width: 3, value: (r) => r.first },
    { key: 'second', header: 'second', width: 5, value: (r) => r.second },
  ];

  const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '');

  const secondColumnOffset = (first: string): number => {
    const { lastFrame } = render(
      <Table
        columns={ALIGNMENT_COLUMNS}
        rows={[{ first, second: 'XXXXX' }]}
        // Out of range for a single-row table: nothing is selected, so the
        // row is never rendered `inverse`, keeping the frame free of the ANSI
        // codes that would otherwise have to be stripped around the marker.
        selectedIndex={1}
        maxLines={8}
        width={20}
        rowKey={() => 'row'}
      />,
    );
    const line = stripAnsi(lastFrame() ?? '')
      .split('\n')
      .find((l) => l.includes('XXXXX'));
    if (line === undefined) throw new Error('second column marker not found in rendered frame');
    return line.indexOf('XXXXX');
  };

  it('a value that truncates on an emoji lines up the next column exactly where plain ASCII of the same declared width does', () => {
    // What would make this fail: `formatCell` regressing to a bare
    // `cliTruncate` call. `cliTruncate('a🔥b', 3)` renders 4 columns wide
    // instead of 3; the padding deficit (`width - stringWidth(truncated)`)
    // then clamps to 0 via `Math.max(0, …)`, so no padding is added and the
    // 'second' column starts one column later for the emoji row than for the
    // ASCII row of the same declared width — the exact misalignment this
    // branch exists to prevent.
    const asciiOffset = secondColumnOffset('abc');
    const emojiOffset = secondColumnOffset('a🔥b');
    // Pin the absolute offset too: a regression that emptied both cells (e.g.
    // `formatCell` always returning `''`) would still satisfy
    // `emojiOffset === asciiOffset` above without this.
    expect(asciiOffset).toBe(6);
    expect(emojiOffset).toBe(asciiOffset);
  });
});
