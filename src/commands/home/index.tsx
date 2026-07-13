import { Box } from 'ink';
import { useCallback, useState } from 'react';
import { runView } from '../../core/run-view.js';
import { saveSnapshot } from '../../core/snapshot-file.js';
import type { StatusMessage } from '../../core/theme.js';
import { freshnessLabel } from '../../ui/freshness.js';
import { StatusBar } from '../../ui/StatusBar.js';
import { useListNavigation } from '../../ui/useListNavigation.js';
import { usePoll } from '../../ui/usePoll.js';
import { LocksApp } from '../locks/index.js';
import { SessionsApp } from '../sessions/index.js';
import { TopApp } from '../top/index.js';
import { Home, PANEL_COUNT, PANEL_DRILLS, type DrillTarget } from './Home.js';
import { fetchTriage, type PanelResult, type TriageData } from './query.js';
import { triageToMarkdown } from './render.js';

/**
 * `pgops` with no subcommand — the product's front door (plan §M2).
 *
 * `HomeApp` polls the six triage queries and presents them; `HubApp` owns
 * navigation: each panel is a door into the view that can fix that problem, and
 * Esc comes back. The cockpit itself is strictly read-only — you act from the
 * view you drilled into.
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
  /** Fired on Enter (panel drill) and `t` (top). The hub swaps the mounted view. */
  onDrill?: (target: DrillTarget) => void;
}

export function HomeApp({ target, onDrill }: HomeAppProps) {
  const [data, setData] = useState<TriageData>(NOT_YET_POLLED);
  const [message, setMessage] = useState<StatusMessage | undefined>();

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

  return (
    <Box flexDirection="column">
      <StatusBar
        subcommand="triage"
        target={target}
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
        message={error ? { text: error, color: 'critical' } : message}
      />
      <Home data={data} focusedPanel={index} />
    </Box>
  );
}

/** Which view is mounted. The hub owns exactly one at a time. */
type ActiveView =
  | { name: 'home' }
  | { name: 'locks' }
  | { name: 'top' }
  | { name: 'sessions'; sort: 'triage' | 'active' };

/** A drill request from the cockpit becomes the view the hub mounts. */
function viewFor(d: DrillTarget): ActiveView {
  if (d.view === 'sessions') return { name: 'sessions', sort: d.sort ?? 'triage' };
  if (d.view === 'locks') return { name: 'locks' };
  return { name: 'top' };
}

export function HubApp({ target }: { target?: string }) {
  const [view, setView] = useState<ActiveView>({ name: 'home' });
  const back = useCallback(() => setView({ name: 'home' }), []);

  if (view.name === 'locks') return <LocksApp target={target} onBack={back} />;
  if (view.name === 'top') return <TopApp target={target} onBack={back} />;
  if (view.name === 'sessions') return <SessionsApp target={target} initialSort={view.sort} onBack={back} />;
  return <HomeApp target={target} onDrill={(d) => setView(viewFor(d))} />;
}

export interface HomeOptions {
  connectionString?: string;
  /** `--snapshot`: print the triage markdown to stdout and exit, no TUI. */
  once?: boolean;
}

export async function runHome(opts: HomeOptions): Promise<void> {
  await runView({
    subcommand: 'triage',
    connectionString: opts.connectionString,
    once: opts.once,
    // `fetchTriage` never rejects, so an unreachable database would otherwise
    // print honest `n/a` markdown and exit 0 (deep-review I1). Hand the runner
    // the all-panels-failed reason: it prints the body AND exits 1, matching
    // every other view's `--snapshot` contract.
    snapshot: async () => {
      const data = await fetchTriage();
      return { body: triageToMarkdown(data), failure: connectionFailure(data) };
    },
    view: (target) => <HubApp target={target} />,
  });
}
