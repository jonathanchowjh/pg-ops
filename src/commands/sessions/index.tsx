import { Box, Text } from 'ink';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDuration } from '../../core/format.js';
import { killBackend, type KillOutcome } from '../../core/kill.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import { theme, type StatusMessage } from '../../core/theme.js';
import { ConfirmModal } from '../../ui/ConfirmModal.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { INK_CLEAR_RESERVE, useTerminalSize } from '../../ui/useTerminalSize.js';
import { prepareSessions, type SessionSort } from './model.js';
import { fetchSessions, type SessionRow } from './query.js';
import { sessionsToMarkdown } from './render.js';
import { Sessions } from './Sessions.js';

/** 2s: a single query, and THE view you kill from — its numbers must be live. */
const REFRESH_MS = 2_000;

// Chrome above and below the table that is always there. Named per-term rather
// than one flat number, matching `locks`: the terms are what a later reader has
// to re-derive, and the flat 6 this replaced had already outlived one addition.
//
// The bordered StatusBar is 3 lines with no message (top border, the
// facts/hints row, bottom border).
const STATUS_BAR_LINES = 3;
// `Sessions`' detail block below the table, at its worst case: a blank margin
// line (`marginTop={1}`), the client/session-began line, and the query line.
// One fewer than `locks`' block, which also carries a waiter breakdown.
const DETAIL_BLOCK_LINES = 3;
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
// spill onto a second line no matter how long it is. The filter prompt takes
// one more while it is open.
const CHROME_LINES = STATUS_BAR_LINES + DETAIL_BLOCK_LINES + TAB_STRIP_LINES;

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
  /** The shell passes 'active' when drilling in from LONG-RUNNING; direct invocation defaults to 'triage'. */
  initialSort?: SessionSort;
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
   * True in two states here, and both matter. With a kill armed, `ConfirmModal`
   * treats any key that is not `y` as cancel — and Ink fires EVERY registered
   * `useInput` handler for a keypress, so `4` would cancel the kill AND jump to
   * `top`. In filter mode, `useListNavigation` deliberately hands the whole
   * keyboard to the search term so you can type `q`, `j`, `1` into it.
   *
   * One boolean, child → parent, reported from an effect and never accepted
   * back as a prop (RULING R-P11): the shell stores it to compute its own
   * hook's `enabled` and never passes it back down, so it cannot loop.
   */
  onCapture?: (captured: boolean) => void;
}

export function SessionsApp({ target, initialSort, strip, onCapture }: SessionsAppProps) {
  const [raw, setRaw] = useState<SessionRow[]>([]);
  const [sort, setSort] = useState<SessionSort>(initialSort ?? 'triage');
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [pending, setPending] = useState<SessionRow | undefined>();
  const [message, setMessage] = useState<StatusMessage | undefined>();
  const terminal = useTerminalSize();

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

  // From an effect, never during render: calling a parent's setter while
  // rendering a child is a React warning and a real hazard.
  useEffect(() => {
    onCapture?.(pending !== undefined || filtering);
  }, [pending, filtering, onCapture]);

  // No `Esc back` (RULING R-P7): the shell owns `Esc`, and a second owner is
  // how a key comes to do two things. Esc's one remaining job here is leaving
  // filter mode, which belongs to the filter.
  const hints = ['j/k move', 'o sort', '/ filter', 'x kill', 's snapshot', 'q quit'];

  // One value, used twice: what StatusBar shows, and what the line budget below
  // has to pay for. A message is showing after every kill outcome, every
  // snapshot and every poll error — exactly when the operator is reading the
  // screen most carefully — so the table has to give a line back.
  const statusMessage: StatusMessage | undefined = error ? { text: error, color: 'critical' } : message;

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="sessions"
        target={target}
        width={terminal.columns}
        cadence={`every ${REFRESH_MS / 1000}s`}
        freshness={freshnessLabel(lastPollAt)}
        hints={hints}
        message={statusMessage}
      />
      {strip}
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
        <Sessions
          rows={rows}
          selectedIndex={index}
          width={terminal.columns}
          // 4, not 3: budgetRows can't honour a ceiling below 4 once the list
          // scrolls (header + ↑ + ↓ already costs 3 lines), so 3 is exactly the
          // value that guarantees an over-budget render. Matches top's floor.
          maxLines={Math.max(4, terminal.rows - INK_CLEAR_RESERVE - CHROME_LINES - (statusMessage ? 1 : 0) - (filtering ? 1 : 0))}
        />
      )}
    </Box>
  );
}
