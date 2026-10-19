import type { Check, Verdict } from '../types.js';
import { counted } from './shared.js';

export interface LockRow {
  pid: number;
  blocked_by: number[];
  usename: string | null;
  app: string | null;
  state: string | null;
  query: string | null;
  backend_start: string | null;
  xact_age_secs: string | null;
  waiting_mode: string | null;
  waiting_on: string | null;
  /**
   * Seconds this session has been waiting, from `pg_locks.waitstart`. NULL
   * when the session holds no ungranted lock (a root blocker).
   */
  wait_secs: string | null;
}

export interface Waiter {
  pid: number; user: string | null; app: string | null; query: string | null;
  state: string | null; backendStart: string | null;
  waitingMode: string | null; waitingOn: string | null;
  /** Age of this session's transaction, not time spent waiting. */
  xactAgeSecs: number | null;
  /**
   * Time this session has spent waiting for a lock, from
   * `pg_locks.waitstart` (PG14+). `verdict` escalates on this.
   *
   * NULL means "not waiting", as for a root blocker. A deadlock's seeded
   * root is itself waiting, so its `waitSecs` is a number.
   */
  waitSecs: number | null;
  waiters: Waiter[];
  /** A back-edge to an ancestor: a deadlock in flight. */
  cycle: boolean;
}

export interface RootBlocker extends Omit<Waiter, 'cycle'> {
  totalWaiters: number;
}

export interface LocksData {
  roots: RootBlocker[];
  /** True when the query's LIMIT dropped rows, so the graph is partial. */
  truncated: boolean;
}

/**
 * Edges come from pg_blocking_pids(), not a self-join on pg_locks: it knows
 * hard blocks, soft blocks (queue position), parallel workers and prepared
 * transactions, so advisory locks are not confused with each other and a
 * queued blocker can be an intermediate node.
 *
 * MATERIALIZED stops the planner inlining the CTE and calling
 * pg_blocking_pids once per reference per row; the function takes exclusive
 * access to the lock manager's shared state.
 *
 * ORDER BY xact_start (oldest first, `pid` tiebreak) keeps the sessions most
 * likely to be root blockers when the LIMIT clips. A dropped waiter row
 * drops its whole subtree in `buildChains`. It sorts on `xact_start`, never
 * the `::text` epoch alias, which would sort lexicographically.
 *
 * LIMIT 501: `map` uses the 501st row to detect truncation, then discards
 * it.
 *
 * `wait_secs` is `now() - min(waitstart)` over the session's ungranted
 * locks; the earliest is the longest wait. `HAVING count(*) > 0` keeps it
 * NULL, not 0, for a session that is not waiting. `waitstart` is briefly
 * NULL for a wait that has only just begun, and the COALESCE to `now()`
 * reads that as about 0, which under-reports rather than over-reports.
 */
const SQL = `
WITH act AS MATERIALIZED (
  SELECT pid, usename, application_name AS app, state, query,
         backend_start::text AS backend_start,
         xact_start,
         EXTRACT(EPOCH FROM (now() - xact_start))::text AS xact_age_secs,
         pg_blocking_pids(pid) AS blocked_by
  FROM pg_stat_activity
  WHERE backend_type = 'client backend'
)
SELECT a.pid, a.usename, a.app, a.state, a.query, a.backend_start,
       a.xact_age_secs, a.blocked_by,
       -- ORDER BY l.mode: a waiter queued on two ungranted locks of different
       -- modes would otherwise get its row order from the planner, and a stable
       -- wait would render as changed between polls. The closing paren is on its
       -- own line because boundaries.test.ts bounds an ORDER BY clause by one.
       (SELECT string_agg(DISTINCT l.mode, ',' ORDER BY l.mode)
          FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted
       ) AS waiting_mode,
       (SELECT string_agg(DISTINCT l.relation::regclass::text, ',') FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted AND l.relation IS NOT NULL) AS waiting_on,
       (SELECT EXTRACT(EPOCH FROM (now() - COALESCE(min(l.waitstart), now())))::text
          FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted
        HAVING count(*) > 0) AS wait_secs
FROM act a
WHERE cardinality(a.blocked_by) > 0
   OR a.pid IN (SELECT unnest(blocked_by) FROM act)
ORDER BY a.xact_start ASC NULLS LAST, a.pid
LIMIT 501`;

/** Fields shared by every node in the tree: a Waiter minus `cycle`. */
function baseFields(r: LockRow, waiters: Waiter[]): Omit<Waiter, 'cycle'> {
  return {
    pid: r.pid, user: r.usename, app: r.app, query: r.query, state: r.state,
    backendStart: r.backend_start,
    waitingMode: r.waiting_mode, waitingOn: r.waiting_on,
    xactAgeSecs: r.xact_age_secs == null ? null : Number(r.xact_age_secs),
    waitSecs: r.wait_secs == null ? null : Number(r.wait_secs),
    waiters,
  };
}

function toWaiter(r: LockRow, waiters: Waiter[], cycle: boolean): Waiter {
  return { ...baseFields(r, waiters), cycle };
}

/**
 * Pure: (pid, blocked_by[]) edges -> root-blocker trees.
 *
 * `path` is the ancestor chain, for cycle detection. `visited` is every pid
 * already placed under this root, so a session reachable twice is shown and
 * counted once. That dedup is per root: a waiter blocked by two independent
 * roots appears under each. For the number of distinct stuck sessions use
 * `countDistinctWaiters`, not a sum of `totalWaiters`.
 */
export function buildChains(rows: LockRow[]): RootBlocker[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const blockedBy = new Map(rows.map((r) => [r.pid, r.blocked_by.filter((p) => p !== r.pid)]));
  const children = new Map<number, number[]>();
  for (const [pid, blockers] of blockedBy) {
    for (const b of blockers) children.set(b, [...(children.get(b) ?? []), pid]);
  }

  const walk = (pid: number, path: Set<number>, visited: Set<number>): { waiters: Waiter[]; count: number } => {
    const waiters: Waiter[] = [];
    let count = 0;
    for (const child of (children.get(pid) ?? []).sort((a, b) => a - b)) {
      const row = byPid.get(child);
      if (!row) continue;
      const cycle = path.has(child);
      if (!cycle && visited.has(child)) continue;
      if (cycle) { waiters.push(toWaiter(row, [], true)); continue; }
      visited.add(child);
      const nested = walk(child, new Set(path).add(child), visited);
      waiters.push(toWaiter(row, nested.waiters, false));
      count += 1 + nested.count;
    }
    return { waiters, count };
  };

  const makeRoot = (pid: number): RootBlocker => {
    const row = byPid.get(pid)!;
    const { waiters, count } = walk(pid, new Set([pid]), new Set());
    return { ...baseFields(row, waiters), totalWaiters: count };
  };

  // `byPid.has(pid)`: pg_blocking_pids() can name a non-client process,
  // which the SQL returns no row for and so cannot be built as a root.
  const rootPids = [...children.keys()]
    .filter((pid) => byPid.has(pid) && (blockedBy.get(pid) ?? []).length === 0)
    .sort((a, b) => a - b);

  const roots = rootPids.map(makeRoot);

  // Every session in a closed cycle is blocked, so none is a root. Seed one
  // entry point per cycle (lowest pid); the `cycle` flag on the back-edge
  // names it a deadlock. This runs even when ordinary roots exist, because a
  // deadlock is a property of one connected component; `covered` stops it
  // re-seeding a pid already in the forest.
  const covered = new Set<number>();
  const collect = (ws: Waiter[]) => { for (const w of ws) { covered.add(w.pid); collect(w.waiters); } };
  for (const root of roots) { covered.add(root.pid); collect(root.waiters); }
  for (const pid of [...children.keys()].sort((a, b) => a - b)) {
    if (covered.has(pid) || !byPid.has(pid)) continue;
    const root = makeRoot(pid);
    covered.add(pid);
    collect(root.waiters);
    roots.push(root);
  }

  return roots.sort((a, b) => b.totalWaiters - a.totalWaiters || a.pid - b.pid);
}

/**
 * The longest time any session in the graph has been waiting, in seconds;
 * `verdict` escalates on this. 0 when nothing is waiting or every
 * `waitSecs` is unknown.
 *
 * Unlike `countDistinctWaiters`, this walk does not skip cycle back-edges
 * or dedup: a maximum cannot be inflated by seeing a session twice.
 */
export function longestWaitSecs(roots: RootBlocker[]): number {
  let longest = 0;
  const collect = (waiters: Waiter[]): void => {
    for (const w of waiters) {
      if (w.waitSecs != null && w.waitSecs > longest) longest = w.waitSecs;
      collect(w.waiters);
    }
  };
  for (const root of roots) {
    if (root.waitSecs != null && root.waitSecs > longest) longest = root.waitSecs;
    collect(root.waiters);
  }
  return longest;
}

/**
 * Distinct waiting pids across every root, not the sum of each root's
 * `totalWaiters`: a session blocked by several roots (a DDL statement queued
 * behind several readers) appears under each and must count once.
 */
export function countDistinctWaiters(roots: RootBlocker[]): number {
  const pids = new Set<number>();
  const collect = (waiters: Waiter[]): void => {
    for (const w of waiters) {
      // A cycle back-edge names a pid already present as a real node.
      if (!w.cycle) pids.add(w.pid);
      collect(w.waiters);
    }
  };
  for (const root of roots) {
    // A root normally is not waiting and does not count. A deadlock's seeded
    // root is waiting, and is reached below only as the skipped back-edge;
    // a non-null `waitSecs` identifies it.
    if (root.waitSecs != null) pids.add(root.pid);
    collect(root.waiters);
  }
  return pids.size;
}

/**
 * Every waiting pid in the graph, mapped to the root blocker it is
 * ultimately queued behind. A `cycle` edge is not recursed into.
 */
export function blockedByRoot(roots: readonly RootBlocker[]): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (waiters: readonly Waiter[], root: number): void => {
    for (const w of waiters) {
      out.set(w.pid, root);
      if (!w.cycle) walk(w.waiters, root);
    }
  };
  for (const r of roots) walk(r.waiters, r.pid);
  return out;
}

/** Root pid → how many sessions are queued behind it. */
export function blockingCounts(roots: readonly RootBlocker[]): Map<number, number> {
  return new Map(roots.map((r) => [r.pid, r.totalWaiters]));
}

export const locks: Check<LockRow, LocksData> = {
  id: 'locks',
  gate: 'wait',
  home: 'session',
  title: 'Lock wait graph',
  class: 'live',
  sql: SQL,
  /**
   * `pg_locks.waitstart` is PG14+. Declared so an older server gets
   * `unsupported-version`, not a raw `42703 column "waitstart" does not
   * exist`.
   */
  requires: [{ kind: 'version', min: 140000 }],
  /** The SQL fetches 501 rows; a 501st means the 500-row graph is partial. */
  map: (rows) => {
    const truncated = rows.length > 500;
    return { roots: buildChains(truncated ? rows.slice(0, 500) : rows), truncated };
  },
  thresholds: [
    { level: 'warn', value: 1, unit: 'count',
      because: 'any session waiting on a lock is a query not completing; it is worth '
             + 'seeing even when brief',
      remedy: 'Open the wait graph and identify the root blocker before the chain grows. '
            + 'A chain is cheapest to break at the top.' },
    { level: 'critical', value: 60, unit: 'seconds',
      because: 'a minute of blocking outlives most application timeouts, so the waiters '
             + 'are already being retried and the pile-up is compounding',
      remedy: 'Terminate the ROOT blocker, not a waiter. Killing a waiter frees nothing '
            + 'and the next one takes its place immediately.' },
  ],
  /** Without a `warn` threshold, any blocked session still escalates. */
  verdict: (d, t): Verdict => {
    const total = countDistinctWaiters(d.roots);
    if (total === 0) return { level: 'ok' };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && total < warn.value) return { level: 'ok' };
    const note = `${counted(total, 'session')} blocked`;
    // The longest actual wait, not the root blocker's transaction age.
    const longestWait = longestWaitSecs(d.roots);
    const crit = t.find((x) => x.level === 'critical');
    if (crit && longestWait >= crit.value) return { level: 'critical', note };
    return { level: 'warn', note };
  },
};
