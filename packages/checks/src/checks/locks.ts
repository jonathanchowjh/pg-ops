import type { Check, Verdict } from '../types.js';

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
   * Seconds this session has been waiting, from `pg_locks.waitstart` — NULL
   * when the session holds no ungranted lock at all (a root blocker). See
   * the `wait_secs` note in the SQL comment below.
   */
  wait_secs: string | null;
}

export interface Waiter {
  pid: number; user: string | null; app: string | null; query: string | null;
  state: string | null; backendStart: string | null;
  waitingMode: string | null; waitingOn: string | null;
  /** Age of this session's transaction. NOT time spent waiting — see A8. */
  xactAgeSecs: number | null;
  /**
   * Time this session has actually spent waiting for a lock, from
   * `pg_locks.waitstart` (PG14+; this package's floor is 14).
   *
   * NULL means "not waiting": a root blocker is unblocked by definition, so
   * it holds no ungranted lock and has no wait to report. The exception is a
   * deadlock, where every session in the cycle is waiting and `buildChains`
   * seeds one of them as a root anyway — that root's `waitSecs` is a real
   * number, because it really is waiting.
   *
   * This is the quantity `verdict` escalates on (I3). `xactAgeSecs` above is
   * still worth showing an operator, but it is not this.
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
  /**
   * True when the query's LIMIT dropped rows. A partial graph an operator
   * knows is partial is useful; one they believe is complete is worse than
   * nothing — see the SQL comment below for why this can't just be a bigger
   * LIMIT.
   */
  truncated: boolean;
}

/**
 * Pre-port review A2. The shipped query self-joined pg_locks on
 * (locktype, database, relation, transactionid) and had two defects:
 *
 *  1. It omitted page, tuple, classid, objid and objsubid. Advisory locks are
 *     identified entirely by classid/objid, so every advisory lock in a database
 *     matched every other one — an uninvolved session was named as a root
 *     blocker, on the view with a kill button.
 *  2. `WHERE NOT blocked.granted AND blocking.granted` meant an edge existed
 *     only when the blocker's own lock was granted, so a QUEUED blocker could
 *     never be an intermediate node. The classic migration pile-up (long read <-
 *     ACCESS EXCLUSIVE <- readers) rendered flat, hiding the amplifier.
 *
 * pg_blocking_pids() knows about hard blocks, soft blocks (queue position),
 * parallel workers, and prepared transactions. It is what the cockpit's blocked
 * panel already used, which is why the two views disagreed.
 *
 * MATERIALIZED is load-bearing: without it the planner may inline the CTE and
 * evaluate pg_blocking_pids once per reference per row, and the function takes
 * exclusive access to the lock manager's shared state. One call per backend.
 *
 * Round-2 review: LIMIT 500 with no ORDER BY undermines A2 in exactly the
 * situation A2 is about. Which 500 rows survive was arbitrary, and if a
 * WAITER's own row is among the ones dropped, `byPid.get(child)` in
 * `buildChains` returns undefined and that whole subtree is silently
 * amputated — during a large incident, the only time this check matters,
 * the graph can quietly under-report and nothing said so.
 *
 * ORDER BY xact_start ASC (oldest transaction first) biases retention toward
 * the sessions most likely to BE root blockers — what you want to keep when
 * you can't keep everything — with `pid` as a deterministic tiebreak so the
 * result is stable across runs. `xact_start`, not the `::text` epoch
 * conversion below: text-sorting "10" before "9" would make the ordering as
 * arbitrary as having none. `NULLS LAST` keeps a session with no known
 * transaction age (which shouldn't occur for a row this WHERE clause
 * selects, but costs nothing to guard) from displacing a session whose age
 * is actually known.
 *
 * LIMIT 501, not 500: `map` below checks for the 501st row to detect
 * truncation and reports it on `LocksData.truncated` before discarding it,
 * rather than silently returning a 500-row graph indistinguishable from a
 * complete one.
 *
 * `wait_secs` (final review I3). `verdict` used to escalate on
 * `max(roots[*].xactAgeSecs)` — the ROOT BLOCKER's transaction age, which
 * `Waiter.xactAgeSecs`'s own doc comment says is "NOT time spent waiting",
 * and which the critical threshold's own `because` contradicts by talking
 * about how long the WAITERS have waited. A lock is held for the life of its
 * transaction, so a blocker's transaction age is always >= the blocking it
 * causes: the error was always toward false-positive. A nightly ETL job
 * holding a transaction open for forty minutes and then blocking one SELECT
 * for 200ms reported `critical`, two levels louder than `blocked` reported
 * the same event.
 *
 * `pg_locks.waitstart` (PG14, and 14 is this package's floor — see the CI
 * matrix) is the real quantity: when THIS session began waiting for the lock
 * it has not been granted. `min(waitstart)` because a session can be queued
 * on several locks at once and the earliest is the longest wait. `HAVING
 * count(*) > 0` is what keeps a root blocker's `wait_secs` NULL rather than
 * 0: an aggregate over an empty set still returns one row (of NULLs), and
 * `EXTRACT(EPOCH FROM (now() - now()))` on the COALESCE below would turn
 * "this session is not waiting at all" into "this session has waited zero
 * seconds", which is a different claim.
 *
 * `waitstart` is documented as briefly NULL for a wait that has only just
 * begun (the process sets it after entering the wait). COALESCE to `now()`
 * so that unknown reads as ~0 rather than as NULL-and-ignored. Under-
 * reporting a wait that genuinely started milliseconds ago is the safe
 * direction here; over-reporting is the entire subject of I3.
 *
 * No `ORDER BY` inside that subquery, deliberately: `min()` needs none, and
 * the package has shipped the lexicographic-::text-ORDER-BY defect three
 * times (see boundaries.test.ts). The outer ORDER BY still reaches
 * `a.xact_start`, the numeric/timestamp source, never the `::text` alias.
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
       (SELECT string_agg(DISTINCT l.mode, ',') FROM pg_locks l
         WHERE l.pid = a.pid AND NOT l.granted) AS waiting_mode,
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

/** Fields shared by every node in the tree — a Waiter minus `cycle`. */
function baseFields(r: LockRow, waiters: Waiter[]): Omit<Waiter, 'cycle'> {
  return {
    pid: r.pid, user: r.usename, app: r.app, query: r.query, state: r.state,
    backendStart: r.backend_start,
    waitingMode: r.waiting_mode, waitingOn: r.waiting_on,
    // xact_age_secs arrives as text (EXTRACT(...)::text in the SQL above), so
    // the numeric conversion happens here, not server-side — see the class
    // comment on connections.ts's ConnectionsRow for why that split exists.
    xactAgeSecs: r.xact_age_secs == null ? null : Number(r.xact_age_secs),
    // Same text->number split as xact_age_secs above, and the same meaning
    // for null: the SQL's HAVING clause returns no row (hence NULL) for a
    // session holding no ungranted lock — see Waiter.waitSecs.
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
 * already placed under THIS root: a wait graph is a graph, not a tree, so a
 * session blocked by two blockers is reachable twice and must be shown — and
 * counted — once. That dedup is per-root only: a waiter blocked by two
 * independent root blockers (pg_blocking_pids returns every conflicting
 * holder, not just one — e.g. a DDL statement queued behind three readers)
 * genuinely belongs under each of those roots' trees. Use
 * `countDistinctWaiters` below, not a sum of `totalWaiters` across roots,
 * when the question is how many distinct sessions are stuck.
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

  // A pid can appear as a blocker (a `children` key) without a row of its
  // own: pg_blocking_pids() can name a parallel worker or other auxiliary
  // process, and this check's SQL restricts its result set to
  // backend_type = 'client backend'. Without the byPid.has(pid) guard,
  // such a pid has no entry in `blockedBy` either, so it reads as
  // "blocked by nothing" and would be treated as a root with no row to
  // build one from.
  const rootPids = [...children.keys()]
    .filter((pid) => byPid.has(pid) && (blockedBy.get(pid) ?? []).length === 0)
    .sort((a, b) => a - b);

  const roots = rootPids.map(makeRoot);

  // Every session in a closed cycle is blocked, so none of them is a root and
  // the view read "no lock contention" during a live deadlock — the one moment
  // this check exists for. Seed one entry point per cycle (lowest pid); the
  // `cycle` flag on the back-edge is what names it a deadlock.
  if (roots.length === 0 && rows.length > 0) {
    const covered = new Set<number>();
    const collect = (ws: Waiter[]) => { for (const w of ws) { covered.add(w.pid); collect(w.waiters); } };
    for (const pid of [...children.keys()].sort((a, b) => a - b)) {
      if (covered.has(pid) || !byPid.has(pid)) continue;
      const root = makeRoot(pid);
      covered.add(pid);
      collect(root.waiters);
      roots.push(root);
    }
  }

  return roots.sort((a, b) => b.totalWaiters - a.totalWaiters || a.pid - b.pid);
}

/**
 * Distinct waiting pids across every root — NOT the sum of each root's own
 * `totalWaiters`.
 *
 * pg_blocking_pids() returns an array: a session can be, and routinely is,
 * blocked by more than one holder at once. The canonical shape in this
 * check's own problem domain is a DDL statement queued behind several
 * readers, each holding a lock the DDL conflicts with — `blocked_by` then
 * has one entry per reader. When those readers are themselves unblocked
 * (each its own root), the DDL session is a genuine member of every one of
 * their trees, and stays shown under each: an operator looking at any single
 * blocker should see that killing it alone won't free the waiter. But
 * `verdict` escalates on how many SESSIONS are stuck, and summing each
 * root's own `totalWaiters` would count that one session once per root
 * blocking it — inflating severity in exactly the incident shape this check
 * exists to diagnose, and scaling with reader count rather than with actual
 * damage. Walking every root's tree into one Set fixes that without needing
 * any "which root owns this waiter" rule — cardinality of a set needs none.
 */
/**
 * The longest time any session in the graph has ACTUALLY been waiting, in
 * seconds. 0 when nothing is waiting, or when every waiter's `waitSecs` is
 * unknown (see `Waiter.waitSecs` on why unknown reads as ~0).
 *
 * This is what `verdict` escalates on (I3) — not `max(roots[*].xactAgeSecs)`,
 * which is how long the BLOCKER's transaction has been open and is bounded
 * below by nothing an operator cares about here.
 *
 * Unlike `countDistinctWaiters` above, this walk does NOT skip cycle
 * back-edges and does not dedup. It doesn't need to: a maximum is
 * idempotent, so seeing the same session twice cannot inflate it the way a
 * count would. Including the back-edge is what makes a deadlock — where
 * `buildChains` seeds one waiting session as a "root" because no unblocked
 * one exists — report the wait it genuinely has.
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

export function countDistinctWaiters(roots: RootBlocker[]): number {
  const pids = new Set<number>();
  const collect = (waiters: Waiter[]): void => {
    for (const w of waiters) {
      // A cycle back-edge re-names a pid already present as a real node
      // elsewhere in the graph (that's the point of the flag) — counting it
      // again here would double-count that session the same way this
      // function exists to prevent across roots.
      if (!w.cycle) pids.add(w.pid);
      collect(w.waiters);
    }
  };
  for (const root of roots) collect(root.waiters);
  return pids.size;
}

export const locks: Check<LockRow, LocksData> = {
  id: 'locks',
  gate: 'wait',
  title: 'Lock wait graph',
  class: 'incident',
  sql: SQL,
  /**
   * `pg_locks.waitstart` is PG14+. The package floor is 14, so every
   * supported server has it — but declaring it means a PG13 server gets
   * `unsupported-version` in words rather than a raw `42703 column
   * "waitstart" does not exist`. query-stats.ts declares the same floor for
   * the same reason.
   */
  requires: [{ kind: 'version', min: 140000 }],
  /**
   * The SQL fetches LIMIT 501. 501 rows back means the true result was cut
   * off by the LIMIT 500 the graph is actually built from — see the SQL
   * comment for why an unsignaled truncation is worse than none here.
   */
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
  /**
   * Neither lookup uses a non-null assertion (see connections.ts's own
   * comment on this): a level's threshold is data this check may not have
   * been given, not a guarantee the type system can see. Absent `warn`,
   * any blocked session still escalates rather than silently reporting ok —
   * this check exists specifically to surface blocking, so "no threshold
   * configured" must fail toward visible, not toward silence.
   */
  verdict: (d, t): Verdict => {
    // countDistinctWaiters, not a sum of d.roots[*].totalWaiters — see that
    // function's comment. A session blocked by three independent root
    // blockers must not escalate severity threefold.
    const total = countDistinctWaiters(d.roots);
    if (total === 0) return { level: 'ok' };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && total < warn.value) return { level: 'ok' };
    // Inlined rather than a shared helper: this package has exactly one
    // dependency and two of these, and `indexes.ts` already writes it this
    // way. The surface's own `plural` is in apps/web and stays there.
    const note = `${total} session${total === 1 ? '' : 's'} blocked`;
    // I3: the LONGEST ACTUAL WAIT (pg_locks.waitstart), not the root
    // blocker's transaction age. The critical threshold's own `because`
    // talks about the waiters having outlived their application timeouts;
    // this is now the quantity that sentence describes. See
    // `longestWaitSecs` and the `wait_secs` note in the SQL comment.
    const longestWait = longestWaitSecs(d.roots);
    const crit = t.find((x) => x.level === 'critical');
    if (crit && longestWait >= crit.value) return { level: 'critical', note };
    return { level: 'warn', note };
  },
};
