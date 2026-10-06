import { counterRates, type CheckResult, type DatabaseActivityData, type Rates } from '@pgops/checks';
// Extensionless — see the comment on the equivalent import in lib/check.ts.
import { ownStatementsSince } from './pools';

/**
 * `Rates` plus the one reading only the web process can take: how much of
 * the rate is this console's own polling.
 *
 * A web-local type rather than a field on `Rates`, because `packages/checks`
 * has no concept of a console that polls — it computes a difference between
 * two readings of `pg_stat_database` and nothing else. Putting `ownPerSec`
 * there would make the library describe its own caller.
 */
export interface PageRates extends Rates {
  /**
   * Statements per second this process issued against the database over the
   * same window as the rates beside it. STATED, never subtracted: the count
   * is per process, so a second replica's polling is invisible here, and a
   * subtracted rate would read as the application's load while being wrong
   * by exactly the amount nobody can see.
   */
  ownPerSec: number;
}

/**
 * The previous good sample per database, in this process. A five-second
 * poll is the only clock this needs; a restart starts over and the page
 * says so for one tick. Deliberately not the store: a rate is a fact about
 * the last five seconds, and the store's cadence is five minutes.
 */
/**
 * Stage 3 re-plan, 2026-10-02. TWO changes from the draft, both deliberate.
 *
 * 1. The elapsed time comes from `sampledAt`, which the CHECK reads as the
 *    server's own `now()` in the same statement as the counters — not from
 *    `result.measuredAt`, which is `Date.now()` on the web host taken BEFORE
 *    the query runs. The counters and the host clock are two different clocks,
 *    and the gap between them is this query's latency, which varies. Dividing a
 *    server-side counter delta by a host-side interval put that jitter straight
 *    into the rate; on a ~5s poll an 800ms slow query is a 16% error in a number
 *    an operator is reading to decide whether load has changed. Same snapshot,
 *    same clock, no correction needed.
 *
 * 2. This is the SECOND piece of module-level mutable state in apps/web, and
 *    `pools.ts:15` calls itself "the ONE piece ... and deliberately so". It
 *    earns its place for the same structural reason: a rate is a difference
 *    between two observations, so something has to outlive one render, and the
 *    alternative — holding a connection open for a second to sample twice —
 *    is the exact "pgops must not be the reason connections run out" rule
 *    pools.ts is written around. Keyed by database NAME here rather than by URL
 *    as POOLS is: the previous sample is only meaningful against the same
 *    counters, and a renamed database should start its series over, which is
 *    the opposite of what POOLS wants.
 *
 *    Known and harmless: in `next dev`, an HMR module reload empties this Map
 *    and the page says "rates after the next refresh" again. Stated here so
 *    nobody debugs it twice.
 */
const LAST = new Map<string, { at: number; data: DatabaseActivityData }>();

export function ratesFor(name: string, result: CheckResult<DatabaseActivityData>): PageRates | null {
  if (!result.ok) return null;
  const prev = LAST.get(name);
  const at = Date.parse(result.data.sampledAt);
  // An unparseable or absent sample instant must not become NaN/s on the page.
  if (!Number.isFinite(at)) return null;
  // B11: read-and-reset on EVERY sample, including the first and including
  // the ones that return null below. The count then covers exactly the
  // window the rate covers, rather than everything since the process
  // started — which on a long-running console is a far larger number and
  // would read as a far busier database.
  const own = ownStatementsSince(name);
  LAST.set(name, { at, data: result.data });
  if (prev === undefined) return null;
  const seconds = (at - prev.at) / 1000;
  const rates = counterRates(prev.data, result.data, seconds);
  if (rates === null) return null;
  return { ...rates, ownPerSec: seconds > 0 ? own / seconds : 0 };
}
