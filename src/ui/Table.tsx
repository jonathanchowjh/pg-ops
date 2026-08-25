import { Box, Text } from 'ink';
import { useRef } from 'react';
import { theme } from '../core/theme.js';
import {
  budgetRows,
  formatCell,
  headerCells,
  solveColumns,
  visibleWindow,
  type Column,
} from './table-layout.js';
import { useTerminalSize } from './useTerminalSize.js';

/** The selection arrow column, `'▸ '` or `'  '`, in front of every row. */
const GUTTER = 2;

/**
 * Floor for `width`. Below roughly this point the gutter and the `+N` dropped-
 * column header hint wrap onto extra lines, and the line budget collapses —
 * measured at width=3 with `maxLines={8}`, a 3-column table rendered **20
 * lines**. No caller passes a width this small today (the fallback is the
 * terminal's own columns, and pgops targets an 80-column terminal as its floor
 * anyway), so this is a belt-and-suspenders clamp rather than a live fix: at an
 * absurd width the terminal now wraps one 20-wide table instead of cascading.
 */
const MIN_WIDTH = 20;

/**
 * The shared table for every list view.
 *
 * Presentation only in the sense the rest of the codebase means it: no fetching,
 * no selection state. It does hold one ref — the previous scroll offset — so the
 * window moves minimally instead of jumping. Mutating a ref during render is the
 * same derived-state escape hatch `sessions/index.tsx:118` already uses.
 *
 * **Who owns the terminal size.** One rule, and every view follows it:
 * `Table` owns the defaults; views pass `width`/`maxLines` straight through
 * without reading the terminal or substituting their own fallback; containers
 * (the `*App` components) read the terminal once and supply real values,
 * subtracting whatever chrome they render around the table. Defaulting in two
 * places is how `sessions` and `top` ended up with different shapes for the
 * same migration — the second default is unreachable in production and only
 * ever disagrees with the first.
 */
export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  selectedIndex: number;
  rowKey: (row: T, index: number) => string;
  /**
   * Total lines the table may occupy, chrome included — NOT a data-row count.
   * `budgetRows` subtracts the header and scroll indicators. Defaults to the
   * terminal's height — again, the only place that default lives; containers
   * pass a smaller number to leave room for their own chrome, and tests pass an
   * explicit value.
   *
   * Below 4, once the list scrolls, this ceiling cannot actually be honoured:
   * header + ↑ + ↓ already costs 3 lines, so `budgetRows` still returns 1 data
   * row rather than 0 (one row beats none) and the real render comes out up to
   * 2 lines over budget. Pass `maxLines >= 4` if you need an exact ceiling.
   */
  maxLines?: number;
  /**
   * Total display columns available. Defaults to the terminal's width — this is
   * the one place that default lives (see above); views pass their prop
   * through, containers supply the real number.
   */
  width?: number;
  /** Column `key` currently sorted, if any — marked in the header. */
  sortKey?: string;
  /** Shown instead of the table when `rows` is empty. */
  empty?: string;
}

export function Table<T>({
  columns, rows, selectedIndex, rowKey, maxLines, width, sortKey, empty,
}: TableProps<T>) {
  const prevStart = useRef(0);
  const terminal = useTerminalSize();

  if (rows.length === 0) {
    // Same 2-column gutter the header and data rows use (the selection arrow
    // column), so the empty message lines up with them instead of sitting
    // flush against the left edge.
    return (
      <Text color={theme.dim}>
        {'  '}
        {empty ?? 'No rows.'}
      </Text>
    );
  }

  const effectiveWidth = Math.max(MIN_WIDTH, width ?? terminal.columns);
  const solved = solveColumns(columns, effectiveWidth - GUTTER);
  const height = budgetRows(maxLines ?? terminal.rows, rows.length);

  const { start, end } = visibleWindow({
    total: rows.length,
    selected: selectedIndex,
    height,
    prevStart: prevStart.current,
  });
  prevStart.current = start;

  const cols = solved.columns;
  const hiddenAbove = start;
  const hiddenBelow = rows.length - end;

  return (
    <Box flexDirection="column" width={effectiveWidth}>
      <Text bold>
        {'  '}
        {headerCells(cols, sortKey).map((cell, i) => (
          <Text key={cols[i]?.key ?? i} color={cell.active ? theme.info : theme.dim}>
            {cell.text}
            {i < cols.length - 1 ? ' ' : ''}
          </Text>
        ))}
        {/* Columns the width could not fit. Never drop data silently. */}
        {solved.dropped.length > 0 ? (
          <Text color={theme.dim}> +{solved.dropped.length}</Text>
        ) : null}
      </Text>

      {hiddenAbove > 0 ? <Text color={theme.dim}>{'  '}↑ {hiddenAbove} more</Text> : null}

      {rows.slice(start, end).map((row, i) => {
        const index = start + i;
        const selected = index === selectedIndex;
        return (
          <Text key={rowKey(row, index)} inverse={selected}>
            {selected ? '▸ ' : '  '}
            {cols.map((c, ci) => (
              <Text key={c.key} color={c.color?.(row, selected)}>
                {formatCell(c.value(row), c.width, c.align, ci < cols.length - 1)}
                {ci < cols.length - 1 ? ' ' : ''}
              </Text>
            ))}
          </Text>
        );
      })}

      {hiddenBelow > 0 ? <Text color={theme.dim}>{'  '}↓ {hiddenBelow} more</Text> : null}
    </Box>
  );
}
