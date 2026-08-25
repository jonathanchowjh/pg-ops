import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { killBackend, type KillOutcome } from '../../core/kill.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { ConfirmModal } from '../../ui/ConfirmModal.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { INK_CLEAR_RESERVE, useTerminalSize } from '../../ui/useTerminalSize.js';
import { buildChains, formatDuration, indexForPid, type RootBlocker } from './chain.js';
import { LockChain } from './LockChain.js';
import { fetchLockEdges, type LockEdge } from './query.js';
import { chainsToMarkdown } from './render.js';

/** 2s: a single query, and this is a view you act from — its numbers must be live. */
const REFRESH_MS = 2_000;

// Chrome outside `Table` that `LockChain` and this container render around it.
// Named per-term (rather than one flat number) so the shell phase's tab strip
// above every view is a one-line `+ TAB_STRIP_LINES` edit here instead of a
// re-derivation. (That edit has now happened — see `TAB_STRIP_LINES` below.)
//
// The bordered StatusBar is 3 lines with no message (top border, the
// facts/hints row, bottom border); the message that comes and goes is
// counted at the call site as a flat "+1", never more, because StatusBar's
// message `<Text>` is `wrap="truncate"` (see StatusBar.tsx) — same reasoning
// as `sessions`/`top`.
const STATUS_BAR_LINES = 3;
// `LockChain`'s detail block below the table, at its worst case (every line
// present): a blank margin line (`marginTop={1}`), the query line, the
// waiter-breakdown line, and the advice line. Not `sessions`' number — this
// view's detail has one more line (the breakdown) than `sessions`' does.
const DETAIL_BLOCK_LINES = 4;
// The tab strip the shell hands down as `strip`. Exactly 2 at EVERY width, not
// "2 at 80 columns": `TabStrip` sets a fixed `height={2}` on its root `Box`
// precisely so this constant can be honest — Ink pads a reserved second row
// when the nine tabs fit on one line, and clips rather than growing a third
// when they don't (see the ruling quoted in `TabStrip.tsx`). So this is a flat
// addend, not a width-dependent one.
const TAB_STRIP_LINES = 2;
// The ` polling pg_locks…` line is NOT an addend here: it only ever renders
// when `roots.length === 0`, and in that state `LockChain`'s detail block
// above does not render at all (there is no selected root) and `Table`
// itself prints a single fixed "No lock contention" line rather than up to
// `maxLines` — so that branch's total is strictly less than the non-empty
// branch the two terms above already cover.
const CHROME_LINES = STATUS_BAR_LINES + DETAIL_BLOCK_LINES + TAB_STRIP_LINES;

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
  /**
   * The tab strip, handed down as an ELEMENT and rendered immediately below
   * this view's own `StatusBar`. The bar stays here because its contents
   * (cadence, freshness, hints, the transient kill message) are per-view and
   * change on every poll; flowing them upward would mean a child firing a
   * callback from an effect into parent state that re-renders the child. The
   * element flows DOWN instead, so there is no upward path to loop through.
   */
  strip?: ReactNode;
  /**
   * "This view currently owns the keyboard; global navigation must go inert."
   *
   * Ink fires EVERY registered `useInput` handler for a keypress — there is no
   * capture and no way to stop propagation — and `ConfirmModal` treats any key
   * that is not `y` as cancel. So with a kill armed and the shell's nav live,
   * pressing `4` would both cancel the kill and jump to `top`. One boolean,
   * child → parent, reported from an effect and never accepted back as a prop
   * (RULING R-P11): the shell stores it to compute its own hook's `enabled`
   * and never passes it back down, so it cannot loop.
   */
  onCapture?: (captured: boolean) => void;
}

export function LocksApp({ target, strip, onCapture }: LocksAppProps) {
  const [roots, setRoots] = useState<RootBlocker[]>([]);
  const [pending, setPending] = useState<RootBlocker | undefined>();
  const [message, setMessage] = useState<StatusMessage | undefined>();
  const terminal = useTerminalSize();

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

  // From an effect, never during render: calling a parent's setter while
  // rendering a child is a React warning and a real hazard.
  useEffect(() => {
    onCapture?.(pending !== undefined);
  }, [pending, onCapture]);

  // No `Esc back` (RULING R-P7): the shell owns `Esc`, and a second owner is
  // how a key comes to do two things.
  const hints = ['j/k move', 'x kill', 's snapshot', 'q quit'];

  const statusMessage: StatusMessage | undefined = error ? { text: error, color: 'critical' } : message;

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="locks"
        target={target}
        width={terminal.columns}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={statusMessage}
      />
      {strip}
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
        <LockChain
          roots={roots}
          selectedIndex={index}
          width={terminal.columns}
          // 4, not 3: `budgetRows` cannot honour a ceiling below 4 once the
          // list scrolls — header + ↑ + ↓ already costs 3 lines — so at 3 it
          // still returns one data row and the render comes out over budget.
          // Matches sessions/top's floor. Unreachable on any terminal taller
          // than 12 rows, so it is a clamp rather than a live guard, and no
          // test covers it: one would have to fabricate a terminal size no
          // operator has.
          maxLines={Math.max(4, terminal.rows - INK_CLEAR_RESERVE - CHROME_LINES - (statusMessage ? 1 : 0))}
        />
      )}
      {roots.length === 0 && !error ? (
        <Text color={theme.dim}> polling pg_locks…</Text>
      ) : null}
    </Box>
  );
}
