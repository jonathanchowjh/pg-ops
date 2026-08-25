import { Box } from 'ink';
import { useCallback, useState, type ReactNode } from 'react';
import { saveSnapshot } from '../../core/snapshot-file.js';
import type { StatusMessage } from '../../core/theme.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { INK_CLEAR_RESERVE, useTerminalSize } from '../../ui/useTerminalSize.js';
import { usePoll } from '../../ui/usePoll.js';
import { Home, PANEL_COUNT, PANEL_DRILLS, type DrillTarget } from './Home.js';
import { fetchTriage, type PanelResult, type TriageData } from './query.js';
import { triageToMarkdown } from './render.js';

/**
 * `pgops` with no subcommand — the product's front door (plan §M2).
 *
 * `HomeApp` polls the six triage queries and presents them, and reports a panel
 * drill upward through `onDrill`. It does NOT own navigation: RULING R-P4
 * deleted the old `HubApp`, which held an `ActiveView`, mounted one of four
 * views and handed each an `onBack`. That is precisely what the shell is, and
 * two objects that both mount-one-of-four and both own `Esc` is one owner too
 * many for a single key. The cockpit itself stays strictly read-only — you act
 * from the view you drilled into.
 */

/**
 * The cockpit polls SLOWER than the drill-down views (deep-review C2).
 *
 * One tick here is SIX queries, one of which (BLOCKED_SQL) calls
 * pg_blocking_pids() per row of pg_stat_activity — not free on a 500-session box
 * under lock contention, which is exactly when this screen is open. The
 * drill-downs keep `REFRESH_MS = 2_000`: each is a single query, and they're the
 * views you act from, so their numbers must be as live as possible. The cockpit
 * is where you *orient*, and 5s of orientation lag costs nothing next to the
 * query volume it saves on a database that is already struggling. (The in-flight
 * guard in `usePoll` bounds the damage either way; this bounds the cost.)
 *
 * Exported so tests assert against the real cadence rather than a copy of it.
 */
export const REFRESH_MS = 5_000;

// Chrome this container renders around the panel stack, per-term the way the
// three list views do it. The bordered StatusBar is 3 lines with no message
// (top border, the facts/hints row, bottom border); the message that comes and
// goes costs a flat 4th, counted at the call site, and never more because
// StatusBar's message `<Text>` is `wrap="truncate"`.
const STATUS_BAR_LINES = 3;
// The tab strip, which is exactly 2 lines at every width by construction — it
// carries a fixed `height={2}` precisely so this can be a constant.
const TAB_STRIP_LINES = 2;
const CHROME_LINES = STATUS_BAR_LINES + TAB_STRIP_LINES;

/**
 * The unmeasured triage: what the cockpit shows before the first poll lands, and
 * what it falls back to when the pool itself is unreachable.
 *
 * Every panel is `{ ok: false }` — NOT zeroed data. A panel that was never
 * measured must never render a ✓: an incident tool that fabricates "all clear"
 * while the database is down is worse than one that shows nothing. Reusing the
 * per-panel isolation path (`{ ok: false, error }`) means Home.tsx already
 * renders this correctly as `n/a (…)`, with no per-panel special-casing.
 */
function unmeasured(error: string): TriageData {
  const p = { ok: false, error } as const;
  return { sessions: p, blocked: p, longRunning: p, connections: p, wraparound: p, slots: p };
}

const NOT_YET_POLLED = unmeasured('not yet polled');

/**
 * Every panel failed → it's the pool, not the panel. `fetchTriage` isolates each
 * query, so an unreachable database RESOLVES (six `{ ok: false }`s) rather than
 * rejecting; without this the screen would show six honest `n/a`s and no reason
 * for them. Name the failure once, in the status bar — and, on the `--snapshot`
 * one-shot, make it the exit code (I1).
 */
export function connectionFailure(d: TriageData): string | undefined {
  // Derived from the object rather than enumerated by field name, so a
  // seventh panel added later is automatically covered by the "did every
  // panel fail?" check instead of silently dropping out of it.
  const panels = Object.values(d) as PanelResult<unknown>[];
  if (panels.some((p) => p.ok)) return undefined;
  const first = panels.find((p) => !p.ok);
  return first && !first.ok ? first.error : undefined;
}

export interface HomeAppProps {
  target?: string;
  /** Fired on Enter (panel drill) and `t` (top). The shell swaps the mounted view. */
  onDrill?: (target: DrillTarget) => void;
  /**
   * The tab strip, handed down as an ELEMENT and rendered directly below this
   * view's own `StatusBar`.
   *
   * The bar stays here rather than moving into the shell because its contents
   * (subcommand, cadence, freshness, hints, the transient message) are per-view
   * and change on every poll; flowing them upward would mean a child firing a
   * callback from an effect into parent state that re-renders the child. So the
   * element flows DOWN and there is no upward path at all.
   *
   * Optional, so a test can render this view without a shell around it.
   */
  strip?: ReactNode;
}

export function HomeApp({ target, onDrill, strip }: HomeAppProps) {
  const [data, setData] = useState<TriageData>(NOT_YET_POLLED);
  const [message, setMessage] = useState<StatusMessage | undefined>();
  const terminal = useTerminalSize();

  // The shared poll loop owns the interval, the in-flight guard, the mount
  // cancellation, and `lastPollAt`. `unmeasured` is the cockpit's one special
  // case: fetchTriage never rejects, so "the database is down" arrives as a
  // resolved payload of six failures — an error to show, with no freshness stamp.
  const { lastPollAt, error } = usePoll<TriageData>({
    fetch: fetchTriage,
    onData: setData,
    refreshMs: REFRESH_MS,
    unmeasured: connectionFailure,
  });

  const onSnapshot = useCallback(async () => {
    setMessage(
      await saveSnapshot({ subcommand: 'triage', target, body: triageToMarkdown(data), filePrefix: 'home' }),
    );
  }, [data, target]);

  const { index } = useListNavigation({
    itemCount: PANEL_COUNT,
    actionKeys: ['t'],
    onSelect: (i) => {
      const drill = PANEL_DRILLS[i];
      if (drill) onDrill?.(drill);
    },
    onAction: (key) => {
      // `t` is the one panel-independent door: pg_stat_statements from anywhere.
      if (key === 't') onDrill?.({ view: 'top' });
    },
    onSnapshot: () => void onSnapshot(),
  });

  // One value, used twice: what StatusBar shows, and what the line budget below
  // has to pay for — the message lives inside the bar's border, so it grows it.
  const statusMessage: StatusMessage | undefined = error ? { text: error, color: 'critical' } : message;

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="triage"
        target={target}
        width={terminal.columns}
        // Freshness WITHOUT cadence — the one deviation from the standard bar
        // (deep-review I2). The cockpit carries the most hints of any view, and
        // both labels together wrap the bar even at 100 columns, splitting
        // "updated just now" across two lines. Cadence is the promise; freshness
        // is the fact, and it is the only label that can contradict the screen —
        // during an outage the poll fails and this keeps ageing, so the bar
        // announces its staleness instead of passing stale data off as live. If
        // only one fits, it is this one. (The drill-downs have room for both.)
        freshness={freshnessLabel(lastPollAt)}
        hints={['j/k panels', 'Enter drill in', 't top', 's snapshot', 'q quit']}
        message={statusMessage}
      />
      {strip}
      {/*
        The cockpit is the one view with no `Table` under it, so nothing clips
        it and it has to spend its own budget — see `budgetHome`. No floor
        clamp here: `budgetHome` already refuses to go below one state row, and
        a `Math.max` would only hide the terminal being genuinely too short.
      */}
      {/*
        The `statusMessage ? 1 : 0` term below is the one part of this budget
        with no test, and not for want of trying: reaching it needs the cockpit
        showing a transient message AND a fixture sitting exactly on
        `budgetHome`'s spacing threshold at the same time. The cockpit's only
        message paths are a snapshot write (which touches the filesystem) and
        an all-panels-failed poll (which replaces the data with six `n/a`s, so
        the panel stack shrinks to one state row and the threshold is nowhere
        near). Every other term IS pinned — see
        `Home.test.tsx`'s "the container spends exactly the budget it
        computes". Named here rather than left for someone to discover.
      */}
      <Home
        data={data}
        focusedPanel={index}
        width={terminal.columns}
        maxLines={terminal.rows - INK_CLEAR_RESERVE - CHROME_LINES - (statusMessage ? 1 : 0)}
      />
    </Box>
  );
}
