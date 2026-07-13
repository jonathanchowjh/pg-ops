import { formatDuration } from '../../core/format.js';
import type { SessionRow } from './query.js';

/**
 * Pure transform: raw pg_stat_activity rows -> sorted, filtered rows for
 * display (plan §A3). The analog of locks/chain.ts and top/stats.ts — no
 * Postgres, no Ink, 100% unit-tested. The view holds the current sort/filter
 * as state and re-runs this on every poll and every keypress.
 */

/** Which order the table is sorted in. `s` cycles through these. */
export type SessionSort = 'triage' | 'active';

const IDLE_IN_TXN = 'idle in transaction';

/** Triage priority: idle-in-transaction first (the #1 dev-caused incident), then active, then idle. */
function triageRank(r: SessionRow): number {
  if (r.state === IDLE_IN_TXN || r.state === 'idle in transaction (aborted)') return 0;
  if (r.state === 'active') return 1;
  return 2;
}

export function prepareSessions(rows: SessionRow[], opts: { sort: SessionSort; filter: string }): SessionRow[] {
  const needle = opts.filter.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((r) => [r.user, r.app, r.state, r.query].some((f) => f?.toLowerCase().includes(needle)))
    : rows;
  const sorted = [...filtered];
  if (opts.sort === 'triage') {
    sorted.sort(
      (a, b) =>
        triageRank(a) - triageRank(b) ||
        (triageRank(a) === 0 ? (b.inStateSecs ?? 0) - (a.inStateSecs ?? 0) : (b.runningSecs ?? 0) - (a.runningSecs ?? 0)),
    );
  } else {
    const rank = (r: SessionRow) => (r.state === 'active' ? 0 : 1);
    sorted.sort((a, b) => rank(a) - rank(b) || (b.runningSecs ?? 0) - (a.runningSecs ?? 0));
  }
  return sorted;
}

/** Human-friendly duration, e.g. 863 -> "14m 23s". Reuses the shared formatter (see core/format.ts). */
export const formatSecs = formatDuration;
