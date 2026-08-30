import Link from 'next/link';
import { connection } from 'next/server';
import { CHECKS, type Verdict, type VerdictLevel } from '@pgops/checks';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { runCheckFor } from '@/lib/check';
import { ConfigErrorPage } from '@/components/config-error';
import { VerdictBadge } from '@/components/verdict-badge';

const RANK: Record<VerdictLevel, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * The overview answers one question — "is anything wrong anywhere?" — so it
 * shows the WORST verdict per database rather than a list of every check. A
 * check that could not run is not a verdict and does not count toward the
 * worst: it is reported separately, because "we could not look" and "we looked
 * and it is fine" must never render the same.
 *
 * C1 (final review): this list used to be `Object.values(CHECKS).filter(c =>
 * c.class === 'incident').map(c => runCheckFor(name, c as Parameters<typeof
 * runCheckFor>[1]))`. `Parameters<…>[1]` resolves against `runCheckFor`'s
 * IMPLEMENTATION signature, so the cast erased the two-overload arity guard
 * that `packages/checks/src/run.ts` was rewritten to provide — and the three
 * opts-bearing checks were then called with no options at all. Their `sql(o)`
 * dereferenced `undefined`, and because `runCheck` NEVER rejects, each came
 * back as an ordinary `{ok:false, reason:'error'}` — "Cannot read properties
 * of undefined (reading 'minSecs' / 'sort' / 'limit')". So every healthy
 * database rendered a permanent, false "3 unavailable", and `longRunning` —
 * the check whose entire job is escalating a runaway query — could never run
 * on the front door at all: a 40-minute runaway rendered as OK.
 *
 * Written out one call per check, the compiler polices every arity again
 * (removing the cast reproduced TS2345 on the old sweep). The cost of an
 * explicit list is that a new incident check can be added to `CHECKS` and
 * forgotten here, so `test/guards.test.ts` reads this source and asserts the
 * two lists agree.
 */
async function worstVerdict(name: string): Promise<{ verdict: Verdict; unavailable: number }> {
  const results = await Promise.all([
    runCheckFor(name, CHECKS.blocked),
    runCheckFor(name, CHECKS.connections),
    runCheckFor(name, CHECKS.locks),
    runCheckFor(name, CHECKS.longRunning, {}),
    runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    runCheckFor(name, CHECKS.sessions, {}),
    runCheckFor(name, CHECKS.sessionStates),
    runCheckFor(name, CHECKS.slots),
    runCheckFor(name, CHECKS.wraparound),
  ]);
  let worst: Verdict = { level: 'ok' };
  let unavailable = 0;
  for (const r of results) {
    if (!r.ok) { unavailable++; continue; }
    if (RANK[r.verdict.level] > RANK[worst.level]) worst = r.verdict;
  }
  return { verdict: worst, unavailable };
}

export default async function Overview() {
  // `databaseNames()` reads `process.env` directly — unlike `runCheckFor`,
  // it carries no `connection()` gate of its own (Task 4 left it a plain
  // sync function; only the per-check seam awaits `connection()`). Called
  // first thing here, on this page, it is ALSO the first `process.env` read
  // this component makes, ahead of any `runCheckFor` call inside
  // `worstVerdict` — so without a dynamic-render signal ahead of it, `next
  // build`'s static-generation pass ran it eagerly, with no request env yet
  // set, and failed the whole build on `ConfigError: No database
  // configured`. `await connection()` here establishes that this route is
  // dynamic before the first env read, exactly the way `runCheckFor` does
  // for every other page — this line is that same guarantee, made explicit
  // for the one page that reaches configuration WITHOUT going through a
  // check first.
  await connection();

  // F4 (final review): `databaseNames()` throws `ConfigError` when pgops
  // cannot read its own configuration, and this is the front door — left
  // uncaught it became Next's generic 500 page, with the only message that
  // names the operator's own input sitting in the container log. Task 1
  // wrote that message precisely so the operator would not have to go
  // looking. Anything else still throws: an unexpected failure here IS a
  // 500, and dressing it up as a configuration problem would send the
  // reader somewhere useless.
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }

  const rows = await Promise.all(names.map(async (name) => ({ name, ...(await worstVerdict(name)) })));

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-xl font-semibold">pgops</h1>
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-4 p-4">
            <Link href={`/db/${r.name}`} className="font-medium underline-offset-4 hover:underline">
              {r.name}
            </Link>
            <span className="flex items-center gap-3">
              {r.unavailable > 0 ? (
                <span className="text-sm text-muted-foreground">{r.unavailable} unavailable</span>
              ) : null}
              <VerdictBadge verdict={r.verdict} />
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
