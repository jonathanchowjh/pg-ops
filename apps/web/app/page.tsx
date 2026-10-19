import Link from 'next/link';
import { connection } from 'next/server';
import { CHECKS, type Verdict, type VerdictLevel } from '@pgops/checks';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { runCheckFor } from '@/lib/check';
import { chainPids } from '@/lib/stuck';
import { ConfigErrorPage } from '@/components/config-error';
import { Refresh } from '@/components/refresh';
import { VerdictBadge, accentClass } from '@/components/verdict-badge';
import { Badge } from '@/components/ui/badge';
import { formatCount, formatDuration, plural } from '@/lib/format';

const RANK: Record<VerdictLevel, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * The worst verdict per database. A check that could not run is not a verdict
 * and does not count toward the worst: it is reported separately, because "we
 * could not look" and "we looked and it is fine" must never render the same.
 *
 * The checks are written out one call each, not mapped over `CHECKS` with a
 * cast: the cast erases `runCheckFor`'s overloads, and an opts-bearing check
 * called without options fails at runtime as "unavailable". A new incident
 * check must be added here; `test/guards.test.ts` asserts the two lists
 * agree.
 */
async function worstVerdict(
  name: string,
): Promise<{ verdict: Verdict | null; unavailable: number; facts: string[] }> {
  const [
    activity, blocked, connections, connectionDetail, horizon, identity, locks,
    longRunning, queryStats, replication, sessions, sessionStates, slots,
    wraparound, throughput, standbyList,
  ] = await Promise.all([
    // Checks that carry no verdict are here too: they cannot worsen the
    // overview, but they can be unavailable, and guards.test.ts holds every
    // incident check to this list. The list is destructured by position, so
    // the names above must stay in this order.
    runCheckFor(name, CHECKS.activity),
    runCheckFor(name, CHECKS.blocked),
    runCheckFor(name, CHECKS.connections),
    runCheckFor(name, CHECKS.connectionDetail, {}),
    runCheckFor(name, CHECKS.horizon),
    runCheckFor(name, CHECKS.identity),
    runCheckFor(name, CHECKS.locks),
    runCheckFor(name, CHECKS.longRunning, {}),
    runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    runCheckFor(name, CHECKS.replicationLag),
    runCheckFor(name, CHECKS.sessions, {}),
    runCheckFor(name, CHECKS.sessionStates),
    runCheckFor(name, CHECKS.slots),
    runCheckFor(name, CHECKS.wraparound),
    runCheckFor(name, CHECKS.databaseActivity),
    runCheckFor(name, CHECKS.standbys),
  ]);
  // Re-listed for the loop. `guards.test.ts` holds both lists to the registry.
  const results = [
    activity, blocked, connections, connectionDetail, horizon, identity, locks,
    longRunning, queryStats, replication, sessions, sessionStates, slots,
    wraparound, throughput, standbyList,
  ];
  // `verdict: null` is a check with no opinion: it cannot worsen the overview
  // and is not counted as an `ok`.
  //
  // `worst` starts null, not `{level: 'ok'}`: seeded with OK, a database
  // where every check failed (an unreachable host) would render OK beside
  // its own "checks unavailable". OK has to be returned by a check.
  let worst: Verdict | null = null;
  let unavailable = 0;
  for (const r of results) {
    if (!r.ok) { unavailable++; continue; }
    if (r.verdict === null) continue;
    if (worst === null || RANK[r.verdict.level] > RANK[worst.level]) worst = r.verdict;
  }
  // The readings behind the badge. The connection count always appears; the
  // rest only when non-zero, so healthy rows stay short.
  const facts: string[] = [];
  if (connections.ok) {
    facts.push(`${formatCount(connections.data.used)} of ${formatCount(connections.data.max)} connections`);
  }
  if (blocked.ok && blocked.data.count > 0) facts.push(`${formatCount(blocked.data.count)} blocked`);
  // The longest query is suppressed when its pid is inside a lock chain:
  // "2 blocked" already states it. It is not suppressed when the lock graph
  // could not be read.
  const chained = chainPids(locks);
  const longest = longRunning.ok ? longRunning.data.queries[0] : undefined;
  if (longest !== undefined && !chained.has(longest.pid)) {
    facts.push(`longest query ${formatDuration(longest.runningSecs)}`);
  }
  if (replication.ok && replication.data.inRecovery) {
    facts.push(
      replication.data.receiving === false
        ? 'standby NOT RECEIVING'
        : replication.data.lagSeconds === null
          ? 'standby · nothing replayed yet'
          : `standby ${formatDuration(replication.data.lagSeconds)} behind`,
    );
  }
  if (standbyList.ok && standbyList.data.standbys.length > 0) {
    let worstReplay: number | null = null;
    for (const sb of standbyList.data.standbys) {
      if (sb.replaySecs === null) continue;
      if (worstReplay === null || sb.replaySecs > worstReplay) worstReplay = sb.replaySecs;
    }
    facts.push(worstReplay === null
      ? `${plural(standbyList.data.standbys.length, 'standby', 'standbys')} · replay unknown`
      : `${plural(standbyList.data.standbys.length, 'standby', 'standbys')} · worst replay ${formatDuration(worstReplay)}`);
  }
  return { verdict: worst, unavailable, facts };
}

export default async function Overview() {
  // `databaseNames()` reads `process.env` and has no `connection()` gate of
  // its own. Without this, `next build`'s static-generation pass runs it
  // with no request env and fails the build on `ConfigError`.
  await connection();

  // A `ConfigError` renders its message instead of Next's generic 500.
  // Anything else still throws.
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }

  const rows = await Promise.all(names.map(async (name) => ({ name, ...(await worstVerdict(name)) })));

  // Not sorted worst-first: rows keep the operator's configured order, which
  // they know by position.
  const attention = rows.filter((r) => r.verdict !== null && r.verdict.level !== 'ok').length;
  // Counted apart from `attention`: a database nothing could be learned about
  // is neither one with a problem nor one without.
  const unknown = rows.filter((r) => r.verdict === null).length;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl font-semibold">pgops</h1>
          <p className="text-sm text-muted-foreground">
            On-call console for Postgres — lock chains, slow queries and replication, live.
          </p>
          <Link
            href="/health"
            className="text-sm underline-offset-4 hover:underline"
          >
            Health over time →
          </Link>
        </div>
        {/* 30s, not the incident pages' 5s: `worstVerdict` runs every
            incident check for every configured database on each tick. */}
        <Refresh intervalMs={30_000} />
      </header>

      <p className="mb-3 text-sm">
        {attention === 0 ? (
          <span className="text-muted-foreground">
            {plural(rows.length, 'database')} · none need attention
          </span>
        ) : (
          <span className="font-medium">
            {/* The verb agrees with `attention`: "1 of 3 databases needs". */}
            {formatCount(attention)} of {plural(rows.length, 'database')}
            {attention === 1 ? ' needs' : ' need'} attention
          </span>
        )}
        {unknown > 0 ? (
          <span className="text-muted-foreground">
            {' · '}{formatCount(unknown)} could not be assessed at all
          </span>
        ) : null}
      </p>

      <ul className="divide-y overflow-hidden rounded-lg border">
        {rows.map((r) => (
          <li key={r.name} className={accentClass(r.verdict)}>
            {/* The whole row is the link target, not just the name. */}
            <Link
              href={`/db/${r.name}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
            >
              {/* Under the name: the incident facts, in muted ink. */}
              <span>
                <span className="font-medium">{r.name}</span>
                {r.facts.length > 0 ? (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{r.facts.join(' · ')}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-3">
                {r.unavailable > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {plural(r.unavailable, 'check')} unavailable
                  </span>
                ) : null}
                {/* No verdict is its own, colourless state. OK would be a
                    claim about a database pgops never managed to read. */}
                {r.verdict === null
                  ? <Badge variant="outline">UNKNOWN</Badge>
                  : <VerdictBadge verdict={r.verdict} />}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
