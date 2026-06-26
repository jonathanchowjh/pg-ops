import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, render, Text } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import { closePool, ConnectionError, getPool } from '../../core/connection.js';
import { buildSnapshot } from '../../core/snapshot.js';
import { theme } from '../../core/theme.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { fetchQueryStats, type QueryStat } from './query.js';
import { queryStatsToMarkdown } from './render.js';
import { cycleSort, prepareRows, type SortMode } from './stats.js';
import { Top } from './Top.js';

const REFRESH_MS = 2_000;

interface Message {
  text: string;
  color: keyof typeof theme;
}

/** Turn a raw driver error into an actionable hint for the common failure. */
function explain(msg: string): string {
  if (/pg_stat_statements/i.test(msg) && /(does not exist|relation|not loaded)/i.test(msg)) {
    return 'pg_stat_statements not available — add it to shared_preload_libraries, restart Postgres, then run: CREATE EXTENSION pg_stat_statements;';
  }
  return msg;
}

function TopApp({ target }: { target?: string }) {
  const [raw, setRaw] = useState<QueryStat[]>([]);
  const [sort, setSort] = useState<SortMode>('total');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<Message | undefined>();

  const poll = useCallback(async () => {
    try {
      setRaw(await fetchQueryStats());
      setError(undefined);
    } catch (err) {
      setError(explain((err as Error).message));
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), REFRESH_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Pure transform on every render — cheap, and keeps the view a function of
  // state. Computed before useListNavigation so rows.length feeds itemCount
  // while filter stays component-owned (no cycle).
  const rows = prepareRows(raw, { sort, filter });

  const onSnapshot = useCallback(async () => {
    const md = buildSnapshot(
      { subcommand: 'top', timestamp: new Date().toISOString(), target },
      queryStatsToMarkdown(rows, sort),
    );
    const dir = join(homedir(), '.pgops', 'snapshots');
    const file = join(dir, `top-${Date.now()}.md`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(file, md, 'utf8');
      setMessage({ text: `snapshot → ${file}`, color: 'success' });
    } catch (err) {
      setMessage({ text: `snapshot failed: ${(err as Error).message}`, color: 'critical' });
    }
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

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="top"
        target={target}
        cadence={`every ${REFRESH_MS / 1000}s`}
        hints={['j/k move', 'o sort', '/ filter', 's snapshot', 'q quit']}
        message={error ? { text: error, color: 'critical' } : message}
      />
      {filtering ? <Text color={theme.info}>/{filter}█</Text> : null}
      <Top rows={rows} sort={sort} selectedIndex={index} filter={filter} />
    </Box>
  );
}

export interface TopOptions {
  connectionString?: string;
}

export async function runTop(opts: TopOptions): Promise<void> {
  try {
    getPool({ connectionString: opts.connectionString });
  } catch (err) {
    if (err instanceof ConnectionError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const target = safeTarget(opts.connectionString ?? process.env.DATABASE_URL);
  const { waitUntilExit } = render(<TopApp target={target} />);
  await waitUntilExit();
  await closePool();
}

/** Show "host:port/db" without credentials for the status bar. */
function safeTarget(connectionString?: string): string | undefined {
  if (!connectionString) return undefined;
  try {
    const u = new URL(connectionString);
    const db = u.pathname.replace(/^\//, '');
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${db ? `/${db}` : ''}`;
  } catch {
    return undefined;
  }
}
