import { runView, type OneShot } from '../../core/run-view.js';
import { connectionFailure } from '../home/index.js';
import { fetchTriage } from '../home/query.js';
import { triageToMarkdown } from '../home/render.js';
import { buildChains } from '../locks/chain.js';
import { fetchLockEdges } from '../locks/query.js';
import { chainsToMarkdown } from '../locks/render.js';
import { prepareSessions } from '../sessions/model.js';
import { fetchSessions } from '../sessions/query.js';
import { sessionsToMarkdown } from '../sessions/render.js';
import { explain } from '../top/index.js';
import { fetchQueryStats } from '../top/query.js';
import { queryStatsToMarkdown } from '../top/render.js';
import { prepareRows } from '../top/stats.js';
import { Shell } from './Shell.js';

/**
 * The ONE runner, for all four subcommands (RULING R-P6).
 *
 * Until v0.2 each command owned its own — `runHome`, `runLocks`, `runTop`,
 * `runSessions` — and each mounted its own view bare. Now every subcommand
 * opens the same app on a different tab, so `view:` has to mount `Shell`. It
 * cannot do that from inside a command: `Shell` imports all four views, so
 * `locks/index.tsx → Shell → locks/index.tsx` is an import cycle. Moving the
 * runners OUT of the view files and up here straightens the dependency into
 * `cli → shell/run → Shell → views`, which is acyclic.
 *
 * This file lives beside `Shell.tsx` rather than in `core/` because it knows
 * every command's queries and renderers. `core/run-view.tsx` stays the layer
 * that knows none of them.
 */

/** The four built tabs. The five unbuilt ones have no runner and no snapshot. */
export type ShellTab = 'triage' | 'sessions' | 'locks' | 'top';

export interface ShellOptions {
  /** The tab to open on. Omitted for bare `pgops` — the cockpit. */
  tab?: ShellTab;
  connectionString?: string;
  /** `--snapshot`: print this tab's markdown to stdout and exit, no TUI. */
  once?: boolean;
}

/**
 * What `--snapshot` does on one tab. The tab NAME doubles as the snapshot
 * label (`# pgops locks snapshot`), so there is no separate `subcommand` field
 * to keep in sync with the tab it belongs to.
 */
interface TabSnapshot {
  /** The one-shot fetch + markdown body. */
  snapshot: () => Promise<OneShot>;
  /** Only `top` has one — see `explain`. */
  mapError?: (message: string) => string;
}

/**
 * Tab → its one-shot. A plain record of data, not a lookup of behaviour: each
 * entry is the closure its own runner used to hold, moved verbatim so that
 * `--snapshot` is bit-for-bit what it was before the shell existed.
 *
 * The one asymmetry is deliberate. `fetchTriage` never rejects — it isolates
 * each of the six panels, so an unreachable database RESOLVES with six
 * failures. Every other tab's fetch rejects, and a rejection is failure enough
 * for `runView`. The cockpit has to name its failure explicitly, or
 * `pgops --snapshot` would print six honest `n/a`s and exit 0 (deep-review I1).
 */
const SNAPSHOTS: Record<ShellTab, TabSnapshot> = {
  triage: {
    snapshot: async () => {
      const data = await fetchTriage();
      return { body: triageToMarkdown(data), failure: connectionFailure(data) };
    },
  },
  sessions: {
    snapshot: async () => ({
      body: sessionsToMarkdown(prepareSessions(await fetchSessions(), { sort: 'triage', filter: '' })),
    }),
  },
  locks: {
    snapshot: async () => ({ body: chainsToMarkdown(buildChains(await fetchLockEdges())) }),
  },
  top: {
    snapshot: async () => ({
      body: queryStatsToMarkdown(prepareRows(await fetchQueryStats(), { sort: 'total', filter: '' }), 'total'),
    }),
    // `top` is the one view with a failure an operator can act on: the
    // extension is usually just not installed. Its own error vocabulary, kept
    // in `top/index.tsx` where the view uses it too.
    mapError: explain,
  },
};

export async function runShell(opts: ShellOptions): Promise<void> {
  const tab = opts.tab ?? 'triage';
  const { snapshot, mapError } = SNAPSHOTS[tab];
  await runView({
    subcommand: tab,
    connectionString: opts.connectionString,
    once: opts.once,
    snapshot,
    mapError,
    view: (target) => <Shell target={target} initialTab={tab} />,
  });
}
