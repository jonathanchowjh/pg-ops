import { Box, Text } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { killBackend, type KillOutcome } from '../../core/kill.js';
import { runView } from '../../core/run-view.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { ConfirmModal } from '../../ui/ConfirmModal.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { buildChains, formatDuration, indexForPid, type RootBlocker } from './chain.js';
import { LockChain } from './LockChain.js';
import { fetchLockEdges, type LockEdge } from './query.js';
import { chainsToMarkdown } from './render.js';

/** 2s: a single query, and this is a view you act from — its numbers must be live. */
const REFRESH_MS = 2_000;

/** Map a kill outcome to the status-bar message (PID-reuse guard, follow-up H). */
function messageForOutcome(outcome: KillOutcome, target: RootBlocker): StatusMessage {
  switch (outcome) {
    case 'terminated':
      return { text: `✓ terminated pid ${target.pid} — ${target.totalWaiters} waiter(s) released`, color: 'success' };
    case 'session-changed':
      // The pid was reused by a different session between selection and confirm;
      // we refused rather than kill an innocent backend.
      return { text: `pid ${target.pid} session changed — not killing`, color: 'warning' };
    case 'gone':
      return { text: `pid ${target.pid} already gone`, color: 'warning' };
  }
}

export interface LocksAppProps {
  target?: string;
  /** Fired on Esc — pop back to the hub. Omit (direct `pgops locks`) and Esc is inert. */
  onBack?: () => void;
}

export function LocksApp({ target, onBack }: LocksAppProps) {
  const [roots, setRoots] = useState<RootBlocker[]>([]);
  const [pending, setPending] = useState<RootBlocker | undefined>();
  const [message, setMessage] = useState<StatusMessage | undefined>();

  // Tracks the pid of the currently selected row so a re-poll can re-point the
  // index at the same backend even if the list is reordered.
  const selectedPidRef = useRef<number | undefined>(undefined);
  // Stable ref to setIndex so onData can call it without becoming a dependency.
  const setIndexRef = useRef<((i: number) => void) | undefined>(undefined);
  // Current selected index, so onData can hold position if the selected pid vanishes.
  const indexRef = useRef(0);

  // The shared poll loop owns the interval, the in-flight guard (a slow poll no
  // longer lets a second one overtake it), the mount cancellation, and freshness.
  const onData = useCallback((edges: LockEdge[]) => {
    const next = buildChains(edges);
    setRoots(next);
    // Keep the cursor on the same backend across re-sorts; if it has resolved
    // and vanished, hold position (clamped) rather than snapping to the top.
    const found = indexForPid(next, selectedPidRef.current);
    setIndexRef.current?.(found >= 0 ? found : Math.min(indexRef.current, Math.max(0, next.length - 1)));
  }, []);

  const { lastPollAt, error, refresh } = usePoll<LockEdge[]>({
    fetch: fetchLockEdges,
    onData,
    refreshMs: REFRESH_MS,
  });

  const onSnapshot = useCallback(async () => {
    setMessage(await saveSnapshot({ subcommand: 'locks', target, body: chainsToMarkdown(roots) }));
  }, [roots, target]);

  const { index, setIndex } = useListNavigation({
    itemCount: roots.length,
    actionKeys: ['x'],
    enabled: pending === undefined,
    onBack,
    onSnapshot: () => void onSnapshot(),
    onAction: (key, i) => {
      // Arm the kill against the highlighted pid, not a raw index, so a poll that
      // re-sorts the list between selection and `x` can't target the wrong backend.
      if (key !== 'x') return;
      const target = roots.find((r) => r.pid === selectedPidRef.current) ?? roots[i];
      if (target) setPending(target);
    },
  });

  // Keep refs current each render so onData sees the latest values.
  selectedPidRef.current = roots[index]?.pid;
  setIndexRef.current = setIndex;
  indexRef.current = index;

  const confirmKill = useCallback(async () => {
    const target = pending;
    setPending(undefined);
    if (!target) return;
    try {
      const outcome = await killBackend(
        { pid: target.pid, backendStart: target.backendStart },
        {
          subcommand: 'locks',
          reason: `blocking ${target.totalWaiters} waiter(s) for ${Math.round(target.heldForSecs ?? 0)}s`,
          meta: { user: target.user, app: target.app, held_mode: target.heldMode },
        },
      );
      setMessage(messageForOutcome(outcome, target));
    } catch (err) {
      setMessage({ text: `kill failed: ${(err as Error).message}`, color: 'critical' });
    }
    refresh();
  }, [pending, refresh]);

  const hints = ['j/k move', 'x kill', 's snapshot', onBack ? 'Esc back' : undefined, 'q quit'].filter(
    (h): h is string => h !== undefined,
  );

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="locks"
        target={target}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={error ? { text: error, color: 'critical' } : message}
      />
      {pending ? (
        <ConfirmModal
          title={`Kill pid ${pending.pid}?`}
          details={[
            `${pending.user ?? '?'}@${pending.app ?? '?'} holding ${pending.heldMode ?? '?'}`,
            `for ${formatDuration(pending.heldForSecs)}, blocking ${pending.totalWaiters} session(s)`,
          ]}
          onConfirm={() => void confirmKill()}
          onCancel={() => setPending(undefined)}
        />
      ) : (
        <LockChain roots={roots} selectedIndex={index} />
      )}
      {roots.length === 0 && !error ? (
        <Text color={theme.dim}> polling pg_locks…</Text>
      ) : null}
    </Box>
  );
}

export interface LocksOptions {
  connectionString?: string;
  once?: boolean;
}

export async function runLocks(opts: LocksOptions): Promise<void> {
  await runView({
    subcommand: 'locks',
    connectionString: opts.connectionString,
    once: opts.once,
    snapshot: async () => ({ body: chainsToMarkdown(buildChains(await fetchLockEdges())) }),
    view: (target) => <LocksApp target={target} />,
  });
}
