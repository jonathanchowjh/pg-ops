import { Box, Text } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { formatDuration } from '../../core/format.js';
import { killBackend, type KillOutcome } from '../../core/kill.js';
import { runView } from '../../core/run-view.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { ConfirmModal } from '../../ui/ConfirmModal.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { prepareSessions, type SessionSort } from './model.js';
import { fetchSessions, type SessionRow } from './query.js';
import { sessionsToMarkdown } from './render.js';
import { Sessions } from './Sessions.js';

/** 2s: a single query, and THE view you kill from — its numbers must be live. */
const REFRESH_MS = 2_000;

/** Map a kill outcome to the status-bar message (same three-way shape as locks). */
function messageForOutcome(outcome: KillOutcome, pid: number): StatusMessage {
  switch (outcome) {
    case 'terminated':
      return { text: `✓ terminated pid ${pid}`, color: 'success' };
    case 'session-changed':
      // The pid was reused by a different session between selection and confirm;
      // we refused rather than kill an innocent backend.
      return { text: `pid ${pid} session changed — not killing`, color: 'warning' };
    case 'gone':
      return { text: `pid ${pid} already gone`, color: 'warning' };
  }
}

export interface SessionsAppProps {
  target?: string;
  /** Hub passes 'active' when drilling in from LONG-RUNNING; direct invocation defaults to 'triage'. */
  initialSort?: SessionSort;
  /** Fired on Esc — pop back to the hub. Omit (direct `pgops sessions`) and Esc is inert. */
  onBack?: () => void;
}

export function SessionsApp({ target, initialSort, onBack }: SessionsAppProps) {
  const [raw, setRaw] = useState<SessionRow[]>([]);
  const [sort, setSort] = useState<SessionSort>(initialSort ?? 'triage');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [pending, setPending] = useState<SessionRow | undefined>();
  const [message, setMessage] = useState<StatusMessage | undefined>();

  // Tracks the pid of the currently selected row so a re-poll (which can
  // re-sort the list — triage order shuffles as sessions change state) can't
  // cause `x` to arm the wrong backend.
  const selectedPidRef = useRef<number | undefined>(undefined);
  // Stable ref to setIndex so onData can re-point it without becoming a dependency.
  const setIndexRef = useRef<((i: number) => void) | undefined>(undefined);
  // Current selected index, so onData can hold position (clamped) if the selected pid vanishes.
  const indexRef = useRef(0);
  // Live sort/filter for onData, which must not close over stale values while
  // re-pointing the cursor after a re-sort.
  const sortRef = useRef(sort);
  const filterRef = useRef(filter);
  sortRef.current = sort;
  filterRef.current = filter;

  // The shared poll loop owns the interval, the in-flight guard, the mount
  // cancellation, and freshness — which this view previously did not show at
  // all (deep-review I2). It is the view you kill from: an operator whose
  // connection dropped 90s ago must not be looking at a dead pid list that
  // still claims to refresh "every 2s".
  const onData = useCallback((fetched: SessionRow[]) => {
    // Keep the cursor on the same backend across re-sorts; if it has resolved
    // and vanished, hold position (clamped) rather than snapping to the top.
    const nextRows = prepareSessions(fetched, { sort: sortRef.current, filter: filterRef.current });
    const found = nextRows.findIndex((r) => r.pid === selectedPidRef.current);
    setIndexRef.current?.(found >= 0 ? found : Math.min(indexRef.current, Math.max(0, nextRows.length - 1)));
    setRaw(fetched);
  }, []);

  const { lastPollAt, error, refresh } = usePoll<SessionRow[]>({
    fetch: fetchSessions,
    onData,
    refreshMs: REFRESH_MS,
  });

  // Pure transform on every render — cheap, and keeps the view a function of
  // state. Computed before useListNavigation so rows.length feeds itemCount
  // while filter/sort stay component-owned (no cycle).
  const rows = prepareSessions(raw, { sort, filter });

  const onSnapshot = useCallback(async () => {
    setMessage(await saveSnapshot({ subcommand: 'sessions', target, body: sessionsToMarkdown(rows) }));
  }, [rows, target]);

  const { index, setIndex } = useListNavigation({
    itemCount: rows.length,
    actionKeys: ['x', 'o'],
    enabled: pending === undefined,
    onBack,
    onSnapshot: () => void onSnapshot(),
    filter: { value: filter, active: filtering, setValue: setFilter, setActive: setFiltering },
    onAction: (key, i) => {
      if (key === 'x') {
        // Arm the kill against the highlighted pid, not a raw index, so a poll
        // that re-sorts the list between selection and `x` can't target the
        // wrong session.
        const t = rows.find((r) => r.pid === selectedPidRef.current) ?? rows[i];
        if (t) setPending(t);
        return;
      }
      if (key === 'o') {
        setSort((s) => (s === 'triage' ? 'active' : 'triage'));
      }
    },
  });

  // Keep refs current each render so onData and the key handlers see the latest values.
  selectedPidRef.current = rows[index]?.pid;
  setIndexRef.current = setIndex;
  indexRef.current = index;

  const confirmKill = useCallback(async () => {
    const t = pending;
    setPending(undefined);
    if (!t) return;
    try {
      const outcome = await killBackend(
        { pid: t.pid, backendStart: t.backendStart },
        {
          subcommand: 'sessions',
          reason: `${t.state} for ${Math.round(t.inStateSecs ?? 0)}s`,
          meta: { user: t.user, app: t.app, state: t.state },
        },
      );
      setMessage(messageForOutcome(outcome, t.pid));
    } catch (err) {
      setMessage({ text: `kill failed: ${(err as Error).message}`, color: 'critical' });
    }
    refresh();
  }, [pending, refresh]);

  const hints = ['j/k move', 'o sort', '/ filter', 'x kill', 's snapshot', onBack ? 'Esc back' : undefined, 'q quit'].filter(
    (h): h is string => h !== undefined,
  );

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="sessions"
        target={target}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={error ? { text: error, color: 'critical' } : message}
      />
      {filtering ? <Text color={theme.info}>/{filter}█</Text> : null}
      {pending ? (
        <ConfirmModal
          title={`Kill pid ${pending.pid}?`}
          details={[
            `${pending.user ?? '?'}@${pending.app ?? '?'} — ${pending.state}`,
            `in state for ${formatDuration(pending.inStateSecs)}`,
          ]}
          onConfirm={() => void confirmKill()}
          onCancel={() => setPending(undefined)}
        />
      ) : (
        <Sessions rows={rows} selectedIndex={index} />
      )}
    </Box>
  );
}

export interface SessionsOptions {
  connectionString?: string;
  once?: boolean;
}

export async function runSessions(opts: SessionsOptions): Promise<void> {
  await runView({
    subcommand: 'sessions',
    connectionString: opts.connectionString,
    once: opts.once,
    snapshot: async () => ({
      body: sessionsToMarkdown(prepareSessions(await fetchSessions(), { sort: 'triage', filter: '' })),
    }),
    view: (target) => <SessionsApp target={target} />,
  });
}
