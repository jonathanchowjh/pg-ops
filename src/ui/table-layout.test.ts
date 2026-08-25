import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import {
  budgetRows,
  formatCell,
  headerCells,
  solveColumns,
  visibleWindow,
  type Column,
  type SolvedColumns,
} from './table-layout.js';

describe('visibleWindow', () => {
  it('shows every row when they all fit, ignoring prevStart', () => {
    expect(visibleWindow({ total: 3, selected: 0, height: 10, prevStart: 7 })).toEqual({ start: 0, end: 3 });
  });

  it('scrolls down by the minimum needed when selection passes the bottom edge', () => {
    // window [0,5) showing rows 0-4; selecting row 5 scrolls exactly one row.
    expect(visibleWindow({ total: 100, selected: 5, height: 5, prevStart: 0 })).toEqual({ start: 1, end: 6 });
  });

  it('does not move while the selection stays inside the window', () => {
    expect(visibleWindow({ total: 100, selected: 12, height: 5, prevStart: 10 })).toEqual({ start: 10, end: 15 });
  });

  it('scrolls up when the selection is above the window', () => {
    expect(visibleWindow({ total: 100, selected: 3, height: 5, prevStart: 10 })).toEqual({ start: 3, end: 8 });
  });

  it('clamps at the end of the list', () => {
    expect(visibleWindow({ total: 20, selected: 19, height: 5, prevStart: 18 })).toEqual({ start: 15, end: 20 });
  });

  it('returns an empty window for an empty list or zero height', () => {
    expect(visibleWindow({ total: 0, selected: 0, height: 5, prevStart: 0 })).toEqual({ start: 0, end: 0 });
    expect(visibleWindow({ total: 10, selected: 0, height: 0, prevStart: 0 })).toEqual({ start: 0, end: 0 });
  });
});

interface Row {
  pid: number;
  state: string;
}

const COLUMNS: Column<Row>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid) },
  { key: 'state', header: 'state', width: 10, value: (r) => r.state },
];

describe('formatCell', () => {
  it('pads left-aligned text to the column width', () => {
    expect(formatCell('ab', 5)).toBe('ab   ');
  });

  it('pads right-aligned text to the column width', () => {
    expect(formatCell('ab', 5, 'right')).toBe('   ab');
  });

  it('truncates with an ellipsis, never exceeding the width', () => {
    expect(formatCell('abcdefgh', 4)).toBe('abc…');
    expect(formatCell('abcdefgh', 4)).toHaveLength(4);
  });

  it('produces a single ellipsis at width 1 and empty string at width 0', () => {
    expect(formatCell('abc', 1)).toBe('…');
    expect(formatCell('abc', 0)).toBe('');
  });

  it('truncates but does not pad when pad is false — the trailing-column case', () => {
    // Short text: no padding added, so the cell is shorter than the column width.
    expect(formatCell('ab', 5, 'left', false)).toBe('ab');
    // Over-long text: still hard-truncated to width, same as the padded case.
    expect(formatCell('abcdefgh', 4, 'left', false)).toBe('abc…');
  });

  /**
   * Review round 1, finding R1-2: `pad: false` exists to stop a LEFT-aligned
   * trailing cell from growing a trailing space that wraps the row (test
   * above). A RIGHT-aligned cell pads on the left, so it can never produce
   * that trailing space — `pad: false` must not also flatten its alignment.
   * The pre-fix `formatCell` returned `truncated` unconditionally whenever
   * `pad` was false, which rendered `locks`' right-aligned, last `blocking`
   * column flush left, silently defeating `align: 'right'`.
   */
  it('a right-aligned trailing column still aligns when pad is false', () => {
    expect(formatCell('2', 9, 'right', false)).toBe('        2');
    expect(formatCell('120', 9, 'right', false)).toBe('      120');
    // A left-aligned trailing column is unaffected: still no padding.
    expect(formatCell('120', 9, 'left', false)).toBe('120');
  });

  it('measures and truncates CJK text by display width, not UTF-16 code units', () => {
    // Fullwidth characters are 1 code unit but 2 display columns each, so
    // `.length`/`.slice` misalign the column to its right (finding 3).
    const result = formatCell('日本語テキストです', 6);
    expect(stringWidth(result)).toBe(6);
  });

  it('never splits an emoji surrogate pair when truncating', () => {
    // `'a🔥b'.slice(0, 2)` would cut the 🔥 surrogate pair in half, emitting a
    // lone, unpaired UTF-16 code unit (finding 3).
    const result = formatCell('a🔥b', 3);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  /**
   * `cli-truncate@4` does not honour its own width cap when the cut lands on a
   * wide or astral grapheme: `cliTruncate('a🔥b', 3)` measures out at `'a🔥…'`,
   * 4 display columns, and `cliTruncate('🔥🔥🔥', 4)` at `'🔥🔥🔥…'`, 7 columns. A
   * `formatCell` still built on a bare `cliTruncate` call would then pad by
   * `Math.max(0, width - stringWidth(truncated))`, which clamps to 0 once the
   * truncated string is already over-wide — so the cell renders wider than its
   * declared column and shifts every column to its right out of alignment.
   * These pin the padded result to never exceed its declared width.
   */
  it('never renders wider than the declared width, even when the cut lands on an emoji', () => {
    expect(stringWidth(formatCell('a🔥b', 3))).toBeLessThanOrEqual(3);
    expect(stringWidth(formatCell('🔥🔥🔥', 4))).toBeLessThanOrEqual(4);
  });

  it('still fits CJK text at its already-correct width (pin, no regression)', () => {
    expect(stringWidth(formatCell('日本語です', 5))).toBeLessThanOrEqual(5);
  });

  it('terminates and stays within width when the very first grapheme is wider than the cap', () => {
    const result = formatCell('🔥', 1);
    expect(stringWidth(result)).toBeLessThanOrEqual(1);
    expect(result).toBe('…');
  });

  it('leaves plain ASCII untouched at several widths — the common path', () => {
    expect(formatCell('hi', 6)).toBe('hi    ');
    expect(formatCell('hello world', 8)).toBe('hello w…');
    // `cli-truncate` reserves its ellipsis column even for a single
    // already-fitting character once `width` is 1 (pinned above too, at
    // `formatCell('abc', 1)`) — that quirk is pre-existing and out of scope.
    expect(formatCell('x', 1)).toBe('…');
  });
});

describe('budgetRows', () => {
  it('reserves one line for the header when everything fits', () => {
    expect(budgetRows(10, 5)).toBe(5);
    expect(budgetRows(6, 5)).toBe(5); // header + 5 rows = 6
  });

  it('reserves both indicator lines once the list scrolls', () => {
    // 6 lines: header + ↑ + 3 rows + ↓
    expect(budgetRows(6, 100)).toBe(3);
  });

  it('keeps the row count stable regardless of how long the list is', () => {
    expect(budgetRows(20, 100)).toBe(budgetRows(20, 10_000));
  });

  it('always yields at least one row while there is room for one', () => {
    expect(budgetRows(3, 100)).toBe(1);
    expect(budgetRows(2, 100)).toBe(1);
  });

  it('yields nothing when there is no room or no rows', () => {
    expect(budgetRows(1, 100)).toBe(0);
    expect(budgetRows(0, 100)).toBe(0);
    expect(budgetRows(-5, 100)).toBe(0);
    expect(budgetRows(20, 0)).toBe(0);
  });
});

describe('budgetRows at and below the 4-line floor', () => {
  // Once the list scrolls, the rendered total is always header + ↑ + rows + ↓
  // (3 chrome lines plus whatever budgetRows returns). The doc comment on
  // budgetRows says a ceiling below 4 cannot be honoured in that regime — these
  // four cases pin exactly where the promise starts and stops holding, with the
  // expected values worked out by hand from `Math.max(1, maxLines - 3)`:
  //
  //   maxLines=4: Math.max(1, 4-3) = Math.max(1, 1) = 1 → renders 4 lines, in budget
  //   maxLines=3: Math.max(1, 3-3) = Math.max(1, 0) = 1 → renders 4 lines, 1 over budget
  //   maxLines=2: Math.max(1, 2-3) = Math.max(1, -1) = 1 → renders 4 lines, 2 over budget
  //   maxLines=1: below the `maxLines < 2` guard, short-circuits to 0 before the
  //               scrolling arithmetic even runs

  it('at maxLines=4 — the lowest budget that can actually be honoured — returns 1 row', () => {
    expect(budgetRows(4, 100)).toBe(1);
  });

  it('at maxLines=3 still returns 1 row (one row beats none), one line over the promised budget', () => {
    expect(budgetRows(3, 100)).toBe(1);
  });

  it('at maxLines=2 still returns 1 row, now two lines over the promised budget', () => {
    expect(budgetRows(2, 100)).toBe(1);
  });

  it('at maxLines=1 gives up entirely — below the guard, 0 rows rather than 1', () => {
    expect(budgetRows(1, 100)).toBe(0);
  });
});

describe('headerCells', () => {
  it('formats each header to its column width, but does not pad the final column', () => {
    // 'pid' (index 0) is not the final column, so it still pads to width 6.
    // 'state' (index 1) IS the final column: padding it would add trailing
    // spaces that push the row past the terminal width and wrap it into a
    // blank line (finding 1).
    expect(headerCells(COLUMNS).map((c) => c.text)).toEqual(['   pid', 'state']);
  });

  it('marks the sorted column active and prefixes it with a caret', () => {
    const cells = headerCells(COLUMNS, 'pid');
    expect(cells[0]).toEqual({ text: '  ▼pid', active: true });
    expect(cells[1]?.active).toBe(false);
  });
});

describe('solveColumns', () => {
  // Mirrors the real sessions set: pid/state/age are load-bearing, `who`
  // duplicates the detail panel, query absorbs slack.
  const cols = (): Column<{ n: number }>[] => [
    { key: 'pid', header: 'pid', width: 6, value: (r) => String(r.n) },
    { key: 'state', header: 'state', width: 22, value: () => '' },
    { key: 'age', header: 'age', width: 8, value: () => '' },
    { key: 'who', header: 'user@app', width: 20, drop: 2, value: () => '' },
    { key: 'query', header: 'query', width: 60, flex: true, min: 20, value: () => '' },
  ];

  /** Total display width of a solved row: cells plus one space between each. */
  const rowWidth = <T,>(s: SolvedColumns<T>) =>
    s.columns.reduce((n, c) => n + c.width, 0) + Math.max(0, s.columns.length - 1);

  it('gives the flex column the leftover width when everything fits', () => {
    const s = solveColumns(cols(), 118);
    expect(s.dropped).toEqual([]);
    expect(s.columns.find((c) => c.key === 'query')?.width).toBe(58);
    expect(rowWidth(s)).toBe(118);
  });

  it('drops the droppable column rather than starving the flex column', () => {
    const s = solveColumns(cols(), 78); // an 80-column terminal, less the gutter
    expect(s.dropped).toEqual(['who']);
    expect(s.columns.map((c) => c.key)).toEqual(['pid', 'state', 'age', 'query']);
    expect(s.columns.find((c) => c.key === 'query')?.width).toBe(39);
    expect(rowWidth(s)).toBe(78);
  });

  it('never exceeds the available width once the set can fit at all', () => {
    // 59 is this set's floor: the three undroppable columns (36) + the query
    // floor (20) + 3 separators. Below it there is nothing left to give.
    for (let w = 59; w <= 200; w++) {
      expect(rowWidth(solveColumns(cols(), w))).toBeLessThanOrEqual(w);
    }
  });

  it('overflows rather than throwing when even the floor will not fit', () => {
    // Deliberate: with no droppable column left, `formatCell` hard-truncates
    // each cell so the table degrades legibly instead of breaking.
    expect(rowWidth(solveColumns(cols(), 30))).toBe(59);
  });

  it('drops highest `drop` first', () => {
    const c: Column<{ n: number }>[] = [
      { key: 'keep', header: 'k', width: 10, value: () => '' },
      { key: 'first', header: 'a', width: 10, drop: 9, value: () => '' },
      { key: 'second', header: 'b', width: 10, drop: 1, value: () => '' },
    ];
    expect(solveColumns(c, 21).dropped).toEqual(['first']);
    expect(solveColumns(c, 10).dropped).toEqual(['first', 'second']);
  });

  it('stops dropping when only undroppable columns remain, and does not mangle them', () => {
    const c: Column<{ n: number }>[] = [
      { key: 'a', header: 'a', width: 10, value: () => '' },
      { key: 'b', header: 'b', width: 10, value: () => '' },
    ];
    const s = solveColumns(c, 5);
    expect(s.columns.map((x) => x.width)).toEqual([10, 10]);
    expect(s.dropped).toEqual([]);
  });

  it('honours the flex floor instead of going negative', () => {
    const s = solveColumns(cols(), 30);
    expect(s.columns.find((x) => x.key === 'query')?.width).toBe(20);
  });

  it('returns nothing when there is no width at all, and names every column it dropped', () => {
    const keys = cols().map((c) => c.key);
    expect(solveColumns(cols(), 0).columns).toEqual([]);
    // Dropping all five silently would leave the header with no `+N` hint —
    // the same "never drop data silently" rule the other branches follow.
    expect(solveColumns(cols(), 0).dropped).toEqual(keys);
    expect(solveColumns(cols(), -10).columns).toEqual([]);
    expect(solveColumns(cols(), -10).dropped).toEqual(keys);
  });

  it('does not mutate the caller-owned column objects', () => {
    const original = cols();
    const before = original.map((c) => c.width);
    solveColumns(original, 78);
    expect(original.map((c) => c.width)).toEqual(before);
  });
});
