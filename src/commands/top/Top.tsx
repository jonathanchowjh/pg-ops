import { Box, Text } from 'ink';
import { theme } from '../../core/theme.js';
import { Table } from '../../ui/Table.js';
import type { Column } from '../../ui/table-layout.js';
import { cellQuery } from './render.js';
import type { QueryRow, SortMode } from './stats.js';

/** Colour the cache cell by how cold it is — the whole point of the cache sort. */
function cacheColor(pct: number | null): string {
  if (pct === null) return theme.dim;
  if (pct < 50) return theme.critical;
  if (pct < 90) return theme.warning;
  return theme.success;
}

/**
 * Column `key`s match `SortMode` so `sortKey` marks the active column with no
 * extra mapping. `cellQuery` redacts — never slice query text directly.
 */
const COLUMNS: Column<QueryRow>[] = [
  {
    key: 'total',
    header: 'total ms',
    width: 9,
    align: 'right',
    value: (r) => String(Math.round(r.totalMs)),
    color: () => theme.fg,
  },
  {
    key: 'mean',
    header: 'mean ms',
    width: 9,
    align: 'right',
    value: (r) => r.meanMs.toFixed(2),
    color: () => theme.fg,
  },
  {
    key: 'calls',
    header: 'calls',
    width: 8,
    align: 'right',
    drop: 3,
    value: (r) => String(r.calls),
    color: () => theme.fg,
  },
  {
    key: 'cache',
    header: 'cache',
    width: 7,
    align: 'right',
    drop: 2,
    value: (r) => (r.cacheHitPct === null ? '—' : `${Math.round(r.cacheHitPct)}%`),
    color: (r) => cacheColor(r.cacheHitPct),
  },
  {
    key: 'query',
    header: 'query',
    width: 70,
    flex: true,
    min: 20,
    value: (r) => cellQuery(r.query, 200),
    // Pre-migration QueryRowLine dimmed the query cell on unselected rows,
    // keeping numeric cells bright regardless of selection.
    color: (_, selected) => (selected ? theme.fg : theme.dim),
  },
];

export interface TopProps {
  rows: QueryRow[];
  sort: SortMode;
  selectedIndex: number;
  /** Active filter term, shown when non-empty. */
  filter?: string;
  /**
   * Total display columns available. Passed straight through to `Table`, which
   * owns the default (see `TableProps`) — this view never reads the terminal
   * itself. Containers supply the real value.
   */
  width?: number;
  /** Total lines the table may occupy. Pass-through, same contract as `width`. */
  maxLines?: number;
}

export function Top({ rows, sort, selectedIndex, filter, width, maxLines }: TopProps) {
  return (
    // No paddingX here: Table sets `width` on its own root Box and solves its
    // columns to fill exactly that, so a parent that pads spends two display
    // columns Table cannot see and every row overflows the budget it was
    // solved against. What Ink does with that overflow is not something
    // anything on this branch measured — don't restore paddingX to find out.
    // Table's own 2-column selection gutter already supplies the left margin.
    <Box flexDirection="column">
      <Table
        columns={COLUMNS}
        rows={rows}
        selectedIndex={selectedIndex}
        sortKey={sort}
        width={width}
        maxLines={maxLines}
        rowKey={(r, i) => String(r.queryid ?? i)}
        empty={
          filter
            ? `No queries match “${filter}”.`
            : 'No query statistics. Is pg_stat_statements populated yet?'
        }
      />
      {filter && rows.length > 0 ? (
        <Text color={theme.dim}>filter: “{filter}” ({rows.length} shown)</Text>
      ) : null}
    </Box>
  );
}
