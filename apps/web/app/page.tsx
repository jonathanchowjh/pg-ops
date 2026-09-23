import Link from 'next/link';
import { connection } from 'next/server';
import { CHECKS, type Verdict, type VerdictLevel } from '@pgops/checks';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { runCheckFor } from '@/lib/check';
import { hygieneFor } from '@/lib/hygiene';
import { ConfigErrorPage } from '@/components/config-error';
import { Refresh } from '@/components/refresh';
import { VerdictBadge, accentClass } from '@/components/verdict-badge';
import { Badge } from '@/components/ui/badge';
import { formatCount, formatDuration, plural } from '@/lib/format';

const RANK: Record<VerdictLevel, number> = { ok: 0, warn: 1, critical: 2 };

/**
 * What the last capture found on this database, in one muted phrase, or
 * nothing at all.
 *
 * The overview's question is "is anything wrong RIGHT NOW", and hygiene is
 * not an answer to it — so this is deliberately the quietest thing on the
 * row: caption size, muted ink, no badge, no accent bar, and it never touches
 * `worstVerdict`. A database with two unused indexes and no incident still
 * reads OK, because it is OK.
 *
 * Nothing at all in three cases, and all three are correct silences: no store
 * (there is no capture to report), a store that could not be read (the
 * incident half of this row is the page's job, and a second failure message
 * per row would bury it), and every area healthy (an operator scanning for
 * trouble does not need twenty rows each saying they have none).
 *
 * `hygieneFor` is one indexed read per database, beside the twelve live
 * checks this page already runs per 30-second tick — so the column is the
 * work, not the data.
 */
async function hygieneSummary(name: string): Promise<string | null> {
  const read = await hygieneFor(name);
  if (!read.ok) return null;
  const loud = read.areas.filter((a) => a.level !== 'ok');
  if (loud.length === 0) return null;
  // The notes, not the levels: "2 unused indexes" is what an operator can act
  // on, where "Indexes WARN" only tells them where to click to find out.
  const notes = loud.map((a) => a.note ?? `${a.label.toLowerCase()} not assessed`);
  const age = loud
    .map((a) => a.ageMs)
    .filter((ms): ms is number => ms !== null)
    .reduce<number | null>((oldest, ms) => (oldest === null || ms > oldest ? ms : oldest), null);
  // The age travels with it for the reason the triage line carries one: this
  // is a cached reading, and a cached reading with no age claims to be
  // current.
  return age === null
    ? notes.join(' · ')
    : `${notes.join(' · ')} · ${formatDuration(age / 1_000)} ago`;
}

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
async function worstVerdict(
  name: string,
): Promise<{ verdict: Verdict | null; unavailable: number }> {
  const results = await Promise.all([
    runCheckFor(name, CHECKS.blocked),
    runCheckFor(name, CHECKS.connections),
    runCheckFor(name, CHECKS.connectionDetail, {}),
    // Carries no verdict, so it can never make the overview worse — but it
    // can be UNAVAILABLE, and this page counts that separately. Present for
    // the same reason `sessions` and `queryStats` are, both also
    // verdict-less: guards.test.ts holds every incident check to the front
    // door, and narrowing that rule to "checks that can escalate" would have
    // quietly excused those two as well.
    runCheckFor(name, CHECKS.identity),
    runCheckFor(name, CHECKS.locks),
    runCheckFor(name, CHECKS.longRunning, {}),
    runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
    // Carries no verdict (see the Ruling in the P2a plan: pgHero has no lag
    // threshold), so it can never worsen the overview — but it CAN be
    // unavailable, which this page counts separately.
    runCheckFor(name, CHECKS.replicationLag),
    runCheckFor(name, CHECKS.sessions, {}),
    runCheckFor(name, CHECKS.sessionStates),
    runCheckFor(name, CHECKS.slots),
    runCheckFor(name, CHECKS.wraparound),
  ]);
  // `verdict: null` is a check with no opinion (spec §1.1). It participates in
  // neither direction: it cannot worsen the overview, and it must not be
  // counted as an `ok` that says a database was judged healthy. Same treatment
  // as `ok: false`, which is counted separately as "unavailable".
  //
  // `worst` starts NULL, and that is the fix for the defect this page was
  // built to prevent. It used to start at `{level: 'ok'}` and only ever move
  // downward, so a database where every single check FAILED — an unreachable
  // host, a wrong connection string, a role denied everything — kept the seed
  // and rendered a positive OK verdict beside its own "12 checks unavailable".
  // That is precisely the confusion the spec forbids in as many words: "we
  // could not look" and "we looked and it's fine" must never render the same,
  // and the front door was rendering them the same. Verified against a
  // deliberately unreachable database, which is the only way to reach this
  // state and the one case no test covered.
  //
  // Starting from null makes OK something a check has to EARN by returning it.
  let worst: Verdict | null = null;
  let unavailable = 0;
  for (const r of results) {
    if (!r.ok) { unavailable++; continue; }
    if (r.verdict === null) continue;
    if (worst === null || RANK[r.verdict.level] > RANK[worst.level]) worst = r.verdict;
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

  const rows = await Promise.all(names.map(async (name) => ({
    name,
    ...(await worstVerdict(name)),
    hygiene: await hygieneSummary(name),
  })));

  // Deliberately NOT sorted worst-first. An operator's database list is one
  // they wrote themselves, in an order that means something to them, and they
  // learn it positionally — "staging is the third row". Re-ordering under them
  // during an incident is when that memory is worth the most and when being
  // wrong about it costs the most. Loudness is what makes the bad row
  // findable; the count below is what makes it findable without scanning at
  // all. Neither of those has to move anything.
  const attention = rows.filter((r) => r.verdict !== null && r.verdict.level !== 'ok').length;
  // Counted apart from `attention` on purpose. A database nothing could be
  // learned about is not a database with a problem and not a database without
  // one; folding it into either count would state something pgops does not
  // know.
  const unknown = rows.filter((r) => r.verdict === null).length;

  // 64rem, not 48. The hygiene column pushed every row into a crowd at the
  // right edge, and this page is a LIST — it needs the width its widest row
  // needs, not the width of a paragraph. Still narrower than the 84rem of
  // /db/*, which holds tables.
  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl font-semibold">pgops</h1>
          <p className="text-sm text-muted-foreground">
            On-call console for Postgres — lock chains, slow queries and replication, live.
          </p>
        </div>
        {/*
          The front door was the one surface with no clock and no way to ask
          again. Every /db/* page states how old its reading is; this page —
          the one left open on a second monitor, whose entire output is the
          claim "none need attention" — went stale silently, and a browser
          reload was the only way to find out.

          30s, not the incident pages' 5s, and the difference is not
          cosmetic: `worstVerdict` runs twelve checks PER DATABASE, so one
          tick here costs twelve times what a triage tick costs, multiplied
          by however many databases are configured. Five seconds against
          twenty databases is 240 queries every five seconds from a console
          whose own README forbids being the reason a database runs out of
          connections. The overview also answers a question that changes on
          a slower clock than a lock chain does — "is anything wrong
          ANYWHERE" — and Refresh is on the same control for the moment that
          is not fast enough.
        */}
        <Refresh intervalMs={30_000} />
      </header>

      {/* The answer to this page's one question, stated rather than left to be
          derived by reading every row. With twenty databases the badges are a
          scan; this is a sentence. */}
      <p className="mb-3 text-sm">
        {attention === 0 ? (
          <span className="text-muted-foreground">
            {plural(rows.length, 'database')} · none need attention
          </span>
        ) : (
          <span className="font-medium">
            {/* The verb agrees with `attention`, which is the subject — "1 of
                3 databases needs attention", not "need". With one database
                configured the old sentence read "1 of 1 database need
                attention" on the console's front page. */}
            {formatCount(attention)} of {plural(rows.length, 'database')}
            {attention === 1 ? ' needs' : ' need'} attention
          </span>
        )}
        {/* Counted and said separately, never folded into the line above. A
            database pgops could not fully read is not a database it judged
            healthy, and this page must not let the two share a sentence. */}
        {unknown > 0 ? (
          <span className="text-muted-foreground">
            {' · '}{formatCount(unknown)} could not be assessed at all
          </span>
        ) : null}
      </p>

      <ul className="divide-y overflow-hidden rounded-lg border">
        {rows.map((r) => (
          <li key={r.name} className={accentClass(r.verdict)}>
            {/* The whole row is the target, not just the six characters of the
                name. This is a console reached on a phone at 3am as often as
                on a desk. */}
            <Link
              href={`/db/${r.name}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 p-4 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none"
            >
              {/* Hygiene sits UNDER the name, not beside the badge.
                  Beside it, "1 unused index · 20s ago" and the verdict's own
                  note "2 sessions blocked" were two pieces of muted text on
                  one line with nothing to say which belonged to which — and
                  the hygiene one came first, so the row led with the thing
                  that is not urgent. Under the name it has an owner.

                  In its own ink either way. pgHero puts hygiene on the
                  dashboard; so does this now, but never in the colour or the
                  weight of an incident — a duplicate index must not tint a
                  row on the page an operator opens while being paged. A
                  database with a hygiene finding and no incident still reads
                  OK, because it is OK: nothing is wrong right now. */}
              <span>
                <span className="font-medium">{r.name}</span>
                {r.hygiene === null ? null : (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{r.hygiene}</span>
                )}
              </span>
              <span className="flex items-center gap-3">
                {r.unavailable > 0 ? (
                  <span className="text-sm text-muted-foreground">
                    {plural(r.unavailable, 'check')} unavailable
                  </span>
                ) : null}
                {/* No verdict at all is its own state, and it is deliberately
                    the colourless one — gray is what "no information" looks
                    like here. Rendering OK would be a claim about a database
                    pgops never managed to read. */}
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
