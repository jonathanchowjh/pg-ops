import { Box, Text } from 'ink';
import { fitToWidth, formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import { Table } from '../../ui/Table.js';
import type { Column } from '../../ui/table-layout.js';
import type { SessionRow } from './query.js';

function stateColor(state: string | null): string {
  if (state === 'active') return theme.success;
  if (state?.startsWith('idle in transaction')) return theme.critical;
  return theme.dim;
}

/**
 * Columns declare intent, not arithmetic (see `solveColumns`). `pid`, `state`,
 * and `age` are undroppable: `state` is the triage signal this view exists for,
 * and a truncated duration lies. `who` is droppable because the selected row's
 * `user@app` is already in the detail panel below, so a narrow terminal loses a
 * convenience rather than a fact. Every query cell still goes through
 * `truncateQuery`, which redacts — never slice `pg_stat_activity.query` directly.
 */
const COLUMNS: Column<SessionRow>[] = [
  { key: 'pid', header: 'pid', width: 6, align: 'right', value: (r) => String(r.pid), color: () => theme.info },
  { key: 'state', header: 'state', width: 22, value: (r) => r.state ?? '?', color: (r) => stateColor(r.state) },
  { key: 'age', header: 'age', width: 8, align: 'right', value: (r) => formatDuration(r.inStateSecs) },
  { key: 'who', header: 'user@app', width: 20, drop: 2, value: (r) => `${r.user ?? '?'}@${r.app || '?'}`, color: () => theme.dim },
  { key: 'query', header: 'query', width: 60, flex: true, min: 20, value: (r) => (r.query ? truncateQuery(r.query, 200) : '') },
];

export interface SessionsProps {
  rows: SessionRow[];
  selectedIndex: number;
  /**
   * Total display columns available. Passed straight through to `Table`, which
   * owns the default (see `TableProps`) — this view never reads the terminal
   * itself. Containers supply the real value.
   */
  width?: number;
  /** Total lines the table may occupy. Pass-through, same contract as `width`. */
  maxLines?: number;
}

/**
 * Presentation only. The selected row's detail sits BELOW the table rather than
 * inline beneath its row: an inline expansion changes how many rows fit, which
 * makes the scroll window oscillate as you move the selection.
 */
export function Sessions({ rows, selectedIndex, width, maxLines }: SessionsProps) {
  const selected = rows[selectedIndex];
  // The detail panel is the one thing here that needs a number rather than a
  // pass-through: it truncates its own lines. With no `width` it is left
  // uncapped rather than defaulting to the terminal — `Table` owns the single
  // default, and a second one here is what made the two migrated views diverge.
  // Every production caller passes a width.
  //
  // An explicit branch rather than a `Number.POSITIVE_INFINITY` sentinel:
  // `fitToWidth`'s documented termination argument (`core/format.ts`) covers
  // finite widths only, so "uncapped" must not rest on `cli-truncate`
  // short-circuiting for an infinite budget — an edge case it does not
  // document.
  const detailWidth = width === undefined ? undefined : Math.max(1, width - 3);
  const clientLine = selected
    ? `client ${selected.clientAddr ?? 'local'} · session began ${selected.backendStart ?? '?'}`
    : '';
  return (
    <Box flexDirection="column">
      <Table
        columns={COLUMNS}
        rows={rows}
        selectedIndex={selectedIndex}
        width={width}
        maxLines={maxLines}
        rowKey={(r) => String(r.pid)}
        empty="No client sessions."
      />
      {selected ? (
        <Box flexDirection="column" marginTop={1}>
          {/*
            The detail lines are subject to the same wrapping rule as the table:
            `<Text>` wraps hard, so a line one column too wide renders as two and
            the panel grows under the table. Both are truncated to the width the
            container gave us, less the 2-column gutter and a column of slack.
            The query line used a flat 200, which wrapped on anything under a
            204-column terminal.
          */}
          <Text color={theme.dim}>
            {'  '}
            {detailWidth === undefined ? clientLine : fitToWidth(clientLine, detailWidth)}
          </Text>
          {selected.query ? (
            <Text color={theme.dim}>
              {'  '}
              {detailWidth === undefined ? truncateQuery(selected.query) : truncateQuery(selected.query, detailWidth)}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
