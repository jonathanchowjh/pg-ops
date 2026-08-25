/**
 * Pure table layout — the column model, cell formatting, and scroll maths that
 * `Table.tsx` draws. No React here, so every rule below is unit-testable.
 */
import stringWidth from 'string-width';
import { fitToWidth } from '../core/format.js';

export interface WindowInput {
  /** Total rows in the list. */
  total: number;
  /** Index of the highlighted row. */
  selected: number;
  /** How many rows fit on screen. */
  height: number;
  /** Where the window sat last render — makes scrolling minimal rather than jumpy. */
  prevStart: number;
}

/** Half-open range: rows `[start, end)` are on screen. */
export interface Window {
  start: number;
  end: number;
}

/**
 * The visible slice of a long list.
 *
 * Minimal-scroll rather than keep-centred: the window only moves when the
 * selection would leave it, so paging through a lock chain doesn't shuffle every
 * row under your eyes. `prevStart` is what makes that stable across renders.
 */
export function visibleWindow({ total, selected, height, prevStart }: WindowInput): Window {
  if (total <= 0 || height <= 0) return { start: 0, end: 0 };
  if (total <= height) return { start: 0, end: total };

  const maxStart = total - height;
  let start = Math.min(Math.max(0, prevStart), maxStart);
  if (selected < start) start = selected;
  else if (selected >= start + height) start = selected - height + 1;

  start = Math.min(Math.max(0, start), maxStart);
  return { start, end: start + height };
}

/**
 * One column. `value` and `color` are functions of the row so the component
 * stays generic — a view declares its columns once instead of hand-padding
 * every cell at every render.
 */
export interface Column<T> {
  /** Stable identifier; also what `sortKey` matches against. */
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  value: (row: T) => string;
  /** A theme colour, or undefined to inherit. `selected` is whether this is the highlighted row. */
  color?: (row: T, selected: boolean) => string | undefined;
  /**
   * This column absorbs leftover width. At most one per column set; in practice
   * always the query column, because it is the only one whose usefulness scales
   * smoothly with the space it gets.
   */
  flex?: boolean;
  /**
   * Floor for a flex column, so a narrow terminal starves it rather than
   * inverting it. Every `flex` column should declare one: `solveColumns`
   * computes `flex.min ?? 1`, so a `flex` column with no `min` can be solved
   * down to width 1 and render every cell as a bare `…`.
   */
  min?: number;
  /**
   * Drop order when the row will not fit — **higher is dropped first**. A column
   * with no `drop` is never dropped: its width is its meaning, and a `pid` cell
   * squeezed to three characters is worse than an absent one.
   */
  drop?: number;
}

/**
 * Fit `text` into at most `width` *display columns*, then (unless `pad` is
 * false) pad it out to exactly `width` columns.
 *
 * Truncation is hard-capped: an over-long cell becomes `abc…`, never a wider
 * string that would shunt every column to its right out of alignment. Width
 * is measured with `string-width` and truncated with `fitToWidth`
 * (`core/format.ts`) rather than `.length`/`.slice` — those count UTF-16 code
 * units, which misaligns every column to the right of a CJK cell (a fullwidth
 * character is one code unit but two display columns) and can split an
 * emoji's surrogate pair in two, emitting a lone, unpaired half. `fitToWidth`
 * exists specifically because the obvious one-liner, a bare
 * `cliTruncate(text, width)`, does not honour its own cap on a wide/astral
 * grapheme (see its doc comment) — a bug that would reintroduce this exact
 * misalignment via the padding deficit clamping to 0 below.
 *
 * `pad` defaults to `true` so every existing call site — every column but the
 * last — keeps its old behaviour untouched. The final column in a row passes
 * `pad: false`: `<Text>` wraps with `hard: true`, so padding a LEFT-aligned
 * cell to width would add a trailing space that pushes the line past the
 * terminal width and wraps it into a blank second line on every row.
 *
 * That trailing-space hazard does not exist for a RIGHT-aligned cell — its
 * padding goes on the left, never the right — so `pad: false` only
 * short-circuits for `align !== 'right'`. Skipping alignment unconditionally
 * (the pre-fix behaviour) left a right-aligned trailing column flush left,
 * silently defeating the one reason a caller declares `align: 'right'` in
 * the first place: `locks`' `blocking` column is the first column set to be
 * both right-aligned and last, which is what surfaced this.
 */
export function formatCell(
  text: string,
  width: number,
  align: 'left' | 'right' = 'left',
  pad = true,
): string {
  if (width <= 0) return '';
  const truncated = fitToWidth(text, width);
  if (!pad && align !== 'right') return truncated;
  const deficit = Math.max(0, width - stringWidth(truncated));
  const padding = ' '.repeat(deficit);
  return align === 'right' ? padding + truncated : truncated + padding;
}

/**
 * Header cells, with the sorted column marked. `active` is returned rather than
 * a colour so the pure layer stays free of theme imports — the component decides
 * how "active" looks.
 */
export function headerCells<T>(
  columns: Column<T>[],
  sortKey?: string,
): { text: string; active: boolean }[] {
  return columns.map((c, i) => {
    const active = c.key === sortKey;
    const pad = i < columns.length - 1;
    return { text: formatCell(active ? `▼${c.header}` : c.header, c.width, c.align, pad), active };
  });
}

/**
 * Data rows that fit in `maxLines` total lines.
 *
 * `Table` spends lines on chrome the caller should not have to count: one header
 * row always, plus an `↑ N more` and a `↓ N more` indicator once the list is
 * longer than the window. Both indicator lines are reserved as soon as the list
 * scrolls at all — even at the very top, where only `↓` renders. Reserving them
 * conditionally would change the row count as the selection moves, making the
 * window jitter under the cursor; one unused line buys a stable table.
 *
 * Below `maxLines = 4`, once the list scrolls, this ceiling cannot be honoured:
 * header + ↑ + ↓ already costs 3 lines, so there is nothing left to give a data
 * row within budget. The function returns 1 anyway rather than 0 — one row beats
 * none — which means the actual render (header + ↑ + 1 row + ↓ = 4 lines) can
 * exceed `maxLines` by up to 2 when `maxLines` is 2 or 3. Callers that need an
 * exact ceiling must pass `maxLines >= 4`.
 */
export function budgetRows(maxLines: number, total: number): number {
  if (maxLines < 2 || total <= 0) return 0;
  const withoutIndicators = maxLines - 1; // header
  if (total <= withoutIndicators) return total;
  return Math.max(1, maxLines - 3); // header + ↑ + ↓
}

/** The surviving columns, resized to fit, plus the keys that did not make it. */
export interface SolvedColumns<T> {
  columns: Column<T>[];
  /** Keys dropped, in the order they were dropped. Rendered as a `+N` header hint. */
  dropped: string[];
}

/**
 * Fit a column set into `available` display columns.
 *
 * `available` is the width left for cells — the caller subtracts the 2-column
 * selection gutter first.
 *
 * Fixed columns keep their declared width, because for a `pid` or a duration the
 * width IS the meaning. Slack goes to the single `flex` column, and when even its
 * floor will not fit, droppable columns are removed highest-`drop`-first. If only
 * undroppable columns remain the row is left over-wide on purpose: `formatCell`
 * hard-truncates each cell, so the table degrades legibly instead of throwing.
 *
 * Pure and non-mutating — callers own their column objects, and the sessions and
 * top column sets are module-level constants that must survive being solved at a
 * different width on every render.
 */
export function solveColumns<T>(columns: Column<T>[], available: number): SolvedColumns<T> {
  if (available <= 0) return { columns: [], dropped: columns.map((c) => c.key) };

  let survivors = [...columns];
  const dropped: string[] = [];

  const fixedSum = (cs: Column<T>[]) =>
    cs.reduce((n, c) => n + (c.flex ? 0 : c.width), 0);
  const flexFloor = (cs: Column<T>[]) => {
    const f = cs.find((c) => c.flex);
    return f ? (f.min ?? 1) : 0;
  };

  for (;;) {
    const need = fixedSum(survivors) + flexFloor(survivors) + Math.max(0, survivors.length - 1);
    if (need <= available) break;

    // Highest `drop` goes first. `reduce` rather than a sort so ties resolve to
    // the earlier declaration, keeping the outcome stable and reviewable.
    const victim = survivors.reduce<Column<T> | undefined>(
      (worst, c) => (c.drop === undefined ? worst : worst === undefined || c.drop > worst.drop! ? c : worst),
      undefined,
    );
    if (!victim) break;

    survivors = survivors.filter((c) => c.key !== victim.key);
    dropped.push(victim.key);
  }

  const flex = survivors.find((c) => c.flex);
  if (!flex) return { columns: survivors, dropped };

  const width = Math.max(flex.min ?? 1, available - fixedSum(survivors) - Math.max(0, survivors.length - 1));
  return {
    columns: survivors.map((c) => (c.flex ? { ...c, width } : c)),
    dropped,
  };
}
