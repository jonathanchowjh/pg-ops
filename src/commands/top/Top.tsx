import { Box, Text } from 'ink';
import { theme } from '../../core/theme.js';
import { cellQuery } from './render.js';
import type { QueryRow, SortMode } from './stats.js';

/**
 * Live slow-query table (plan §A2). The analog of locks/LockChain.tsx: a pure
 * presentational component. All state (rows, sort, filter, selection) is owned
 * by index.tsx; this just draws what it's handed.
 */

// Fixed column widths so numbers line up; the query column takes the rest.
const W = { total: 9, mean: 9, calls: 8, cache: 7 } as const;

const HEADERS: Record<SortMode, string> = {
  total: 'total ms',
  mean: 'mean ms',
  calls: 'calls',
  cache: 'cache',
};

/** Right-align a value into a fixed-width column. */
function col(value: string, width: number): string {
  return value.padStart(width);
}

/** Color the cache cell by how cold it is — the whole point of the cache sort. */
function cacheColor(pct: number | null): string {
  if (pct === null) return theme.dim;
  if (pct < 50) return theme.critical;
  if (pct < 90) return theme.warning;
  return theme.success;
}

function HeaderRow({ sort }: { sort: SortMode }) {
  const head = (key: SortMode, label: string, width: number) => (
    <Text color={key === sort ? theme.info : theme.dim} bold={key === sort}>
      {col(key === sort ? `▼${label}` : label, width)}
    </Text>
  );
  return (
    <Box>
      {head('total', HEADERS.total, W.total)}
      <Text> </Text>
      {head('mean', HEADERS.mean, W.mean)}
      <Text> </Text>
      {head('calls', HEADERS.calls, W.calls)}
      <Text> </Text>
      {head('cache', HEADERS.cache, W.cache)}
      <Text color={theme.dim}> query</Text>
    </Box>
  );
}

function QueryRowLine({ row, selected }: { row: QueryRow; selected: boolean }) {
  const marker = selected ? '❯ ' : '  ';
  return (
    <Box>
      <Text color={selected ? theme.info : theme.dim}>{marker}</Text>
      <Text color={theme.fg}>{col(String(Math.round(row.totalMs)), W.total - 2)} </Text>
      <Text color={theme.fg}>{col(row.meanMs.toFixed(2), W.mean)} </Text>
      <Text color={theme.fg}>{col(String(row.calls), W.calls)} </Text>
      <Text color={cacheColor(row.cacheHitPct)}>
        {col(row.cacheHitPct === null ? '—' : `${Math.round(row.cacheHitPct)}%`, W.cache)}
      </Text>
      <Text color={selected ? theme.fg : theme.dim}> {cellQuery(row.query, 70)}</Text>
    </Box>
  );
}

export interface TopProps {
  rows: QueryRow[];
  sort: SortMode;
  selectedIndex: number;
  /** Active filter term, shown when non-empty. */
  filter?: string;
}

export function Top({ rows, sort, selectedIndex, filter }: TopProps) {
  if (rows.length === 0) {
    return (
      <Box paddingX={1} flexDirection="column">
        {filter ? (
          <Text color={theme.dim}>No queries match “{filter}”.</Text>
        ) : (
          <Text color={theme.dim}>No query statistics. Is pg_stat_statements populated yet?</Text>
        )}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <HeaderRow sort={sort} />
      {rows.map((row, i) => (
        <QueryRowLine key={row.queryid ?? i} row={row} selected={i === selectedIndex} />
      ))}
      {filter ? <Text color={theme.dim}>filter: “{filter}” ({rows.length} shown)</Text> : null}
    </Box>
  );
}
