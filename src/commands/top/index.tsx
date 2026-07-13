import { Box, Text } from 'ink';
import { useCallback, useState } from 'react';
import { runView } from '../../core/run-view.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { fetchQueryStats, type QueryStat } from './query.js';
import { queryStatsToMarkdown } from './render.js';
import { cycleSort, prepareRows, type SortMode } from './stats.js';
import { Top } from './Top.js';

/** 2s: a single query, and a drill-down you act on — its numbers must be live. */
const REFRESH_MS = 2_000;

/** Turn a raw driver error into an actionable hint for the common failure. */
export function explain(msg: string): string {
  if (/pg_stat_statements/i.test(msg) && /(does not exist|relation|not loaded)/i.test(msg)) {
    return 'pg_stat_statements not available — add it to shared_preload_libraries, restart Postgres, then run: CREATE EXTENSION pg_stat_statements;';
  }
  return msg;
}

export interface TopAppProps {
  target?: string;
  /** Fired on Esc — pop back to the hub. Omit (direct `pgops top`) and Esc is inert. */
  onBack?: () => void;
}

export function TopApp({ target, onBack }: TopAppProps) {
  const [raw, setRaw] = useState<QueryStat[]>([]);
  const [sort, setSort] = useState<SortMode>('total');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [message, setMessage] = useState<StatusMessage | undefined>();

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
    onBack,
    onSnapshot: () => void onSnapshot(),
    onAction: (key) => {
      // `o` cycles the sort order; `s` (snapshot) stays consistent with every view.
      if (key === 'o') setSort((s) => cycleSort(s));
    },
    filter: { value: filter, active: filtering, setValue: setFilter, setActive: setFiltering },
  });

  const hints = ['j/k move', 'o sort', '/ filter', 's snapshot', onBack ? 'Esc back' : undefined, 'q quit'].filter(
    (h): h is string => h !== undefined,
  );

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="top"
        target={target}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={error ? { text: error, color: 'critical' } : message}
      />
      {filtering ? <Text color={theme.info}>/{filter}█</Text> : null}
      <Top rows={rows} sort={sort} selectedIndex={index} filter={filter} />
    </Box>
  );
}

export interface TopOptions {
  connectionString?: string;
  once?: boolean;
}

export async function runTop(opts: TopOptions): Promise<void> {
  await runView({
    subcommand: 'top',
    connectionString: opts.connectionString,
    once: opts.once,
    snapshot: async () => ({
      body: queryStatsToMarkdown(prepareRows(await fetchQueryStats(), { sort: 'total', filter: '' }), 'total'),
    }),
    view: (target) => <TopApp target={target} />,
    mapError: explain,
  });
}
