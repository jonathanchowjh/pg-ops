import type { LockEdge } from './query.js';

/**
 * Pure transform: flat wait-graph edges -> root-blocker trees (plan §A1).
 *
 * Root blocker = a session that is blocking someone but is not itself blocked by
 * anyone in the result set. Each root has a cascade of waiters; a waiter may
 * itself block others, so the tree nests.
 *
 * No Postgres or Ink dependency — this is the unit-tested core.
 */

export interface Waiter {
  pid: number;
  user: string | null;
  app: string | null;
  query: string | null;
  /** Lock mode this session is waiting to acquire. */
  waitingMode: string | null;
  /** Relation it's contending on, if any. */
  table: string | null;
  /** How long this session's transaction has been open, in seconds. */
  waitingForSecs: number | null;
  /** Sessions blocked by this one. */
  waiters: Waiter[];
  /** True if a cycle was detected at this node (deadlock in flight). */
  cycle: boolean;
  state: string | null;
}

export interface RootBlocker {
  pid: number;
  user: string | null;
  app: string | null;
  query: string | null;
  /** Lock mode this session holds. */
  heldMode: string | null;
  /** How long this blocker's transaction has been open, in seconds. */
  heldForSecs: number | null;
  waiters: Waiter[];
  /** Transitive count of everything waiting under this root. */
  totalWaiters: number;
  state: string | null;
}

/** First edge where `pid` is the blocker — used to read its held-side fields. */
function blockerInfo(edges: LockEdge[], pid: number): LockEdge | undefined {
  return edges.find((e) => e.blocking_pid === pid);
}

function buildWaiters(edges: LockEdge[], blockerPid: number, path: Set<number>): { waiters: Waiter[]; count: number } {
  const seen = new Set<number>();
  const waiters: Waiter[] = [];
  let count = 0;

  for (const edge of edges) {
    if (edge.blocking_pid !== blockerPid) continue;
    if (seen.has(edge.blocked_pid)) continue; // dedup multi-locktype edges
    seen.add(edge.blocked_pid);

    const cycle = path.has(edge.blocked_pid);
    let childWaiters: Waiter[] = [];
    let childCount = 0;
    if (!cycle) {
      const nested = buildWaiters(edges, edge.blocked_pid, new Set(path).add(edge.blocked_pid));
      childWaiters = nested.waiters;
      childCount = nested.count;
    }

    waiters.push({
      pid: edge.blocked_pid,
      user: edge.blocked_user,
      app: edge.blocked_app,
      query: edge.blocked_query,
      waitingMode: edge.waiting_mode,
      table: edge.table_name,
      waitingForSecs: edge.blocked_for_secs,
      waiters: childWaiters,
      cycle,
      state: edge.blocked_state,
    });
    // A cycle node is the same pid already counted higher up — don't double-count it.
    count += cycle ? 0 : 1 + childCount;
  }

  return { waiters, count };
}

export function buildChains(edges: LockEdge[]): RootBlocker[] {
  const blockedPids = new Set(edges.map((e) => e.blocked_pid));
  const rootPids = new Set<number>();
  for (const edge of edges) {
    // A blocker that is never itself blocked is a root.
    if (!blockedPids.has(edge.blocking_pid)) rootPids.add(edge.blocking_pid);
  }

  const roots: RootBlocker[] = [];
  for (const pid of rootPids) {
    const info = blockerInfo(edges, pid);
    const { waiters, count } = buildWaiters(edges, pid, new Set([pid]));
    roots.push({
      pid,
      user: info?.blocking_user ?? null,
      app: info?.blocking_app ?? null,
      query: info?.blocking_query ?? null,
      heldMode: info?.held_mode ?? null,
      heldForSecs: info?.blocking_for_secs ?? null,
      waiters,
      totalWaiters: count,
      state: info?.blocking_state ?? null,
    });
  }

  // Worst offenders first.
  roots.sort((a, b) => b.totalWaiters - a.totalWaiters);
  return roots;
}

/** Row index of the given pid, or -1 when absent (the caller chooses the fallback). */
export function indexForPid(roots: RootBlocker[], pid: number | undefined): number {
  if (pid === undefined) return -1;
  return roots.findIndex((r) => r.pid === pid);
}

/** Human-friendly duration, e.g. 863 -> "14m 23s". */
export function formatDuration(secs: number | null): string {
  // null = unknown; negative = clock skew (xact_start in the future) — both meaningless.
  if (secs == null || secs < 0) return '—';
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Flatten the waiter tree and tally how many sessions each app has waiting. */
export function waiterAppBreakdown(waiters: Waiter[]): { app: string; count: number }[] {
  const counts = new Map<string, number>();
  const walk = (ws: Waiter[]) => {
    for (const w of ws) {
      const app = w.app ?? '?';
      counts.set(app, (counts.get(app) ?? 0) + 1);
      walk(w.waiters);
    }
  };
  walk(waiters);
  return [...counts.entries()]
    .map(([app, count]) => ({ app, count }))
    .sort((a, b) => b.count - a.count);
}
