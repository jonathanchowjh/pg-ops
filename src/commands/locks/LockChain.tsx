import { Box, Text } from 'ink';
import { fitToWidth, formatDuration, truncateQuery } from '../../core/format.js';
import { theme } from '../../core/theme.js';
import { Table } from '../../ui/Table.js';
import type { Column } from '../../ui/table-layout.js';
import { adviseBlocker } from './advise.js';
import { waiterAppBreakdown, type RootBlocker } from './chain.js';

/**
 * Columns declare intent, not arithmetic (see `solveColumns`). `pid` is never
 * dropped and carries no decoration beyond the number itself (review round 1,
 * R1-1): a ⚠ marker was tried first, but at 2 display columns wide
 * (`stringWidth('⚠') === 2`, not 1) it left only 5 of the column's 7 columns
 * for the digits, so a 6- or 7-digit pid (`kernel.pid_max` defaults to
 * 4194304 on modern systemd hosts, so these are ordinary, not extreme)
 * rendered identically to a different backend's pid — in the one column an
 * operator reads to decide which backend to kill. Widening the column isn't
 * available either: at width 80 the fixed sum is already exactly the
 * available width, so +1 column drops `mode`. The marker was also redundant:
 * every row here IS a blocker by construction of `buildChains`, severity is
 * already carried by `waiters`, and selection is already carried by `Table`'s
 * `▸` — the marker was 2 columns of zero information in front of the one
 * field that has to be exact. `held` (state + how long) is the triage signal
 * this view exists for, so it is undroppable too. `waiters` is never dropped
 * either — it's the severity ranking (`buildChains` sorts worst-offenders-
 * first), so losing it on a narrow terminal would hide the one number that
 * says which row matters most. `who` and `mode` are droppable, `mode` first:
 * the lock mode is useful context but `held`'s state/duration and `waiters`'
 * count are enough to decide whether to kill. Query text never appears in a
 * column — it's pathological length and belongs in the detail block below,
 * through `truncateQuery`, never a bare `.slice()`.
 */
const COLUMNS: Column<RootBlocker>[] = [
  { key: 'pid', header: 'pid', width: 7, value: (r) => String(r.pid), color: () => theme.info },
  { key: 'who', header: 'user@app', width: 20, drop: 2, value: (r) => `${r.user ?? '?'}@${r.app ?? '?'}`, color: () => theme.dim },
  { key: 'held', header: 'state · held', width: 22, value: (r) => `${r.state ?? '?'} ${formatDuration(r.heldForSecs)}`, color: () => theme.warning },
  { key: 'mode', header: 'mode', width: 16, drop: 3, value: (r) => r.heldMode ?? '?', color: () => theme.dim },
  { key: 'waiters', header: 'blocking', width: 9, align: 'right', value: (r) => String(r.totalWaiters), color: () => theme.warning },
];

export interface LockChainProps {
  roots: RootBlocker[];
  selectedIndex: number;
  /**
   * Total display columns available. Passed straight through to `Table`,
   * which owns the default (see `TableProps`) — this view never reads the
   * terminal itself. Containers supply the real value.
   */
  width?: number;
  /** Total lines the table may occupy. Pass-through, same contract as `width`. */
  maxLines?: number;
}

/**
 * Presentation only. The selected root's detail sits BELOW the table rather
 * than inline beneath its row, exactly as `Sessions.tsx` does and for the
 * same reason: an inline expansion changes how many rows fit, which makes
 * the scroll window oscillate as you move the selection.
 */
export function LockChain({ roots, selectedIndex, width, maxLines }: LockChainProps) {
  const selected = roots[selectedIndex];
  // Same reasoning as `Sessions.tsx:61`: with no `width` the detail is left
  // uncapped (every production caller passes one) rather than this view
  // inventing its own terminal-size default — `Table` owns the single
  // default, and a second one here is exactly what made `sessions` and `top`
  // diverge before that migration.
  //
  // `width - 3` is the budget for a 2-column prefix (`'  '`) plus a column of
  // slack, matching `Sessions.tsx`'s two detail lines — which is exactly
  // right for the query and breakdown lines below, both of which share that
  // same 2-column `'  '` prefix.
  const detailWidth = width === undefined ? undefined : Math.max(1, width - 3);
  const fit = (text: string) => (detailWidth === undefined ? text : fitToWidth(text, detailWidth));
  // The advice line's prefix is 4 columns, not 2 (`'  '` + `'▸ '`), so
  // reusing `detailWidth` here let it reach `width + 1` (review round 1,
  // R1-3). Budget is `width - 5`: the 4-column prefix plus the same one
  // column of slack `detailWidth` carries. Re-check this arithmetic before
  // changing the prefix string below.
  const adviceWidth = width === undefined ? undefined : Math.max(1, width - 5);
  const fitAdvice = (text: string) => (adviceWidth === undefined ? text : fitToWidth(text, adviceWidth));

  const advice = selected ? adviseBlocker(selected) : undefined;
  const breakdown = selected
    ? waiterAppBreakdown(selected.waiters).map((b) => `${b.app}×${b.count}`).join(', ')
    : '';

  return (
    <Box flexDirection="column">
      <Table
        columns={COLUMNS}
        rows={roots}
        selectedIndex={selectedIndex}
        width={width}
        maxLines={maxLines}
        rowKey={(r) => String(r.pid)}
        empty="No lock contention. The DB is not blocked."
      />
      {selected && advice ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>
            {'  '}
            {detailWidth === undefined ? truncateQuery(selected.query) : truncateQuery(selected.query, detailWidth)}
          </Text>
          {breakdown ? (
            <Text color={theme.dim}>
              {'  '}
              {fit(`blocking ${selected.totalWaiters} → ${breakdown}`)}
            </Text>
          ) : null}
          <Text color={advice.tone === 'safe' ? theme.success : theme.warning}>
            {'  '}▸ {fitAdvice(advice.text)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
