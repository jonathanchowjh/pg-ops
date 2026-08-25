import { Box, Text } from 'ink';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { INK_CLEAR_RESERVE, useTerminalSize } from '../../ui/useTerminalSize.js';
import { fetchQueryStats, type QueryStat } from './query.js';
import { queryStatsToMarkdown } from './render.js';
import { cycleSort, prepareRows, type SortMode } from './stats.js';
import { Top } from './Top.js';

/** 2s: a single query, and a drill-down you act on — its numbers must be live. */
const REFRESH_MS = 2_000;

// Chrome that is always there. Named per-term rather than one flat number,
// matching `locks` and `sessions`: the terms are what a later reader has to
// re-derive, and the flat 4 this replaced had already outlived one addition.
//
// The bordered StatusBar is 3 lines with no message (top border, the
// facts/hints row, bottom border).
const STATUS_BAR_LINES = 3;
// `Top`'s `filter: "…" (N shown)` summary line below the table. Budgeted
// unconditionally even though it only renders with a non-empty filter: paying
// for it always costs one row of the list, whereas charging for it only when
// it shows would make the table grow and shrink under the cursor as you type.
const FILTER_SUMMARY_LINES = 1;
// The tab strip the shell hands down as `strip`. Exactly 2 at EVERY width, not
// "2 at 80 columns": `TabStrip` pins a fixed `height={2}` on its root `Box`
// precisely so this constant can be honest — Ink pads a reserved second row
// when the nine tabs fit on one line, and clips rather than growing a third
// when they don't. So this is a flat addend, not a width-dependent one.
const TAB_STRIP_LINES = 2;
// The two lines that come and go are counted at the call site instead: StatusBar
// renders the message INSIDE its border, so it costs a 4th line whenever one is
// showing — safely a flat "+1" and never more, because StatusBar's message
// `<Text>` is `wrap="truncate"` (see StatusBar.tsx), so a message can never
// spill onto a second line no matter how long it is. The filter PROMPT (a
// separate line from the summary above) takes one more while it is open.
const CHROME_LINES = STATUS_BAR_LINES + FILTER_SUMMARY_LINES + TAB_STRIP_LINES;

/** Turn a raw driver error into an actionable hint for the common failure. */
export function explain(msg: string): string {
  if (/pg_stat_statements/i.test(msg) && /(does not exist|relation|not loaded)/i.test(msg)) {
    return 'pg_stat_statements not available — add it to shared_preload_libraries, restart Postgres, then run: CREATE EXTENSION pg_stat_statements;';
  }
  return msg;
}

export interface TopAppProps {
  target?: string;
  /**
   * The tab strip, handed down as an ELEMENT and rendered immediately below
   * this view's own `StatusBar`. The bar stays here because its contents
   * (cadence, freshness, hints, the transient snapshot message) are per-view
   * and change on every poll; flowing them upward would mean a child firing a
   * callback from an effect into parent state that re-renders the child. The
   * element flows DOWN instead, so there is no upward path to loop through.
   */
  strip?: ReactNode;
  /**
   * "This view currently owns the keyboard; global navigation must go inert."
   *
   * `top` has no confirm modal, so filter mode is its only capturing state —
   * and it is a real one: `useListNavigation` deliberately hands the whole
   * keyboard to the search term so you can type `q`, `j`, `1` into it, while
   * Ink fires EVERY registered `useInput` handler for a keypress. Without this
   * report, typing `4` into a filter would also navigate away mid-word.
   *
   * One boolean, child → parent, reported from an effect and never accepted
   * back as a prop (RULING R-P11): the shell stores it to compute its own
   * hook's `enabled` and never passes it back down, so it cannot loop.
   */
  onCapture?: (captured: boolean) => void;
}

export function TopApp({ target, strip, onCapture }: TopAppProps) {
  const [raw, setRaw] = useState<QueryStat[]>([]);
  const [sort, setSort] = useState<SortMode>('total');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [message, setMessage] = useState<StatusMessage | undefined>();
  const terminal = useTerminalSize();

  // The shared poll loop owns the interval, the in-flight guard, the mount
  // cancellation, and freshness (which this view previously did not show at all
  // — deep-review I2). `explain` stays here: it is top's own error vocabulary.
  const { lastPollAt, error } = usePoll<QueryStat[]>({
    fetch: fetchQueryStats,
    onData: setRaw,
    refreshMs: REFRESH_MS,
    mapError: (err) => explain((err as Error).message),
  });

  // Pure transform on every render — cheap, and keeps the view a function of
  // state. Computed before useListNavigation so rows.length feeds itemCount
  // while filter stays component-owned (no cycle).
  const rows = prepareRows(raw, { sort, filter });

  const onSnapshot = useCallback(async () => {
    setMessage(await saveSnapshot({ subcommand: 'top', target, body: queryStatsToMarkdown(rows, sort) }));
  }, [rows, sort, target]);

  const { index } = useListNavigation({
    itemCount: rows.length,
    actionKeys: ['o'],
    onSnapshot: () => void onSnapshot(),
    onAction: (key) => {
      // `o` cycles the sort order; `s` (snapshot) stays consistent with every view.
      if (key === 'o') setSort((s) => cycleSort(s));
    },
    filter: { value: filter, active: filtering, setValue: setFilter, setActive: setFiltering },
  });

  // From an effect, never during render: calling a parent's setter while
  // rendering a child is a React warning and a real hazard.
  useEffect(() => {
    onCapture?.(filtering);
  }, [filtering, onCapture]);

  // No `Esc back` (RULING R-P7): the shell owns `Esc`, and a second owner is
  // how a key comes to do two things. Esc's one remaining job here is leaving
  // filter mode, which belongs to the filter.
  const hints = ['j/k move', 'o sort', '/ filter', 's snapshot', 'q quit'];

  // One value, used twice: what StatusBar shows, and what the line budget below
  // has to pay for — the message lives inside the bar's border, so it grows it.
  const statusMessage: StatusMessage | undefined = error ? { text: error, color: 'critical' } : message;

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="top"
        target={target}
        width={terminal.columns}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={statusMessage}
      />
      {strip}
      {filtering ? <Text color={theme.info}>/{filter}█</Text> : null}
      <Top
        rows={rows}
        sort={sort}
        selectedIndex={index}
        filter={filter}
        width={terminal.columns}
        maxLines={Math.max(4, terminal.rows - INK_CLEAR_RESERVE - CHROME_LINES - (statusMessage ? 1 : 0) - (filtering ? 1 : 0))}
      />
    </Box>
  );
}
