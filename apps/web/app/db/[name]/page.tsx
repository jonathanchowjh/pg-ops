import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CHECKS, GATES, GATE_ORDER,
  type ActivityData, type CheckResult, type Gate, type Placement, type Verdict,
} from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { ratesFor } from '@/lib/rates';
import { hygieneFor } from '@/lib/hygiene';
import type { HygieneArea } from '@pgops/checks';
import { chainPids, stuckFrom } from '@/lib/stuck';
import { HygieneLine } from '@/components/hygiene-line';
import { CheckPanel, needsAttention } from '@/components/check-panel';
import { Throughput } from '@/components/throughput';
import { Badge } from '@/components/ui/badge';
import { Bullet } from '@/components/bullet';
import { Refresh } from '@/components/refresh';
import { Sql } from '@/components/sql';
import { formatBytes, formatCount, formatDuration, formatMillis, plural } from '@/lib/format';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: name };
}

/**
 * One panel, with its data type erased so a band can hold a mixed list.
 *
 * The bands have to RANK their panels — an incident renders full width with
 * its explanation, a healthy check renders as one compact line — and that is
 * a decision about the list, which JSX children cannot express: `children`
 * arrives already rendered and opaque, so nothing downstream can ask a child
 * what its verdict was.
 *
 * The two casts are the whole cost, and they are confined here. Each call
 * site stays fully checked, because `panel` is generic in `T` and binds
 * `result` to `render` at that point; by the time the type is erased, the
 * compiler has already proved the renderer matches the data it will be
 * handed. Nothing downstream ever narrows `unknown` back.
 */
interface PanelSpec {
  /**
   * Which gate of a request this panel measures, taken from the CHECK rather
   * than written here — see gates.ts. The page does not decide where a check
   * belongs; the check does, and this file only groups by what it is told.
   */
  gate: Placement;
  title: string;
  result: CheckResult<unknown>;
  render: (data: unknown, verdict: Verdict | null) => ReactNode;
  summary?: (data: unknown) => ReactNode;
  /**
   * The title of the panel in this band that this one merely corroborates.
   *
   * Set on a panel that measures the SAME incident as another from a
   * different angle. When the panel it names is already loud, this one stays
   * compact no matter how bad its own verdict is — because the band has
   * already spent a full card, an accent bar and a paragraph of guidance on
   * that incident, and a second of each is not a second problem.
   *
   * Only when its lead is quiet does it get promoted on its own merit, which
   * is the case where the two genuinely disagree and both need reading.
   */
  secondaryTo?: string;
  /**
   * A17: the pid this panel's verdict is ABOUT, when it is about one
   * session.
   *
   * Set it and the panel folds to a compact line whenever that pid is
   * already inside a loud lock chain — across bands, which is what
   * `secondaryTo` above cannot do: it names a panel in the same band, and
   * three of the four echoes this fixes are in other bands.
   *
   * Left unset by a panel that is not about one session. Active now,
   * Throughput and Query statistics describe the whole server, so a chain
   * explains nothing about them and they must keep their own weight.
   */
  pid?: number | null;
  /**
   * The id to put on this panel's card, for the folded lines to link to.
   *
   * On the spec rather than matched by title inside `Band`, so the band
   * stays ignorant of which panel is which — the same reason `gate` is read
   * off the check instead of written here.
   */
  anchor?: string;
}

/**
 * `summary` is what the panel says when it is healthy enough to be one line.
 *
 * Not cosmetic. Without it, a compact panel rendered its FULL body inside a
 * one-line slot: the healthy Query statistics panel put four wrapped lines of
 * somebody's SQL in the quiet half of the Queries band, which was both
 * taller than the incident beside it and — because the worst shape on a
 * console watching its own store is one of pgops's own catalog reads — an
 * advertisement for the least interesting query on the server.
 *
 * A panel with no summary keeps its full renderer, which is correct for the
 * ones already one line long.
 */
function panel<T>(
  check: { gate: Placement },
  title: string,
  result: CheckResult<T>,
  render: (data: T, verdict: Verdict | null) => ReactNode,
  summary?: (data: T) => ReactNode,
): PanelSpec {
  return {
    gate: check.gate,
    title,
    result: result as CheckResult<unknown>,
    render: render as (data: unknown, verdict: Verdict | null) => ReactNode,
    summary: summary as ((data: unknown) => ReactNode) | undefined,
  };
}

/**
 * The wait-bucket fragment of the "Active now" summary line, shared by its
 * loud and compact renderers.
 *
 * `waits` empty and `restricted` false really does mean nothing is
 * executing. `waits` empty and `restricted` true means this role's SQL
 * filtered on `state`, which it cannot read for a backend it does not own
 * (see activity.ts's ActivityRow.sees_all docblock) — "nothing executing"
 * would be the exact false-negative Fix 1 exists to close, so a blind
 * summary line gets the honest alternative instead.
 *
 * B10: folds by wait TYPE, because that is the unit a summary line is in.
 * `activity` groups by (wait_event_type, wait_event), so one type routinely
 * spans several events, and printing `w.type` per bucket rendered the same
 * word several times with different numbers beside it: the seeded lock chain
 * read "2 active · 1 Lock · 1 Lock". One row per event is right for the
 * Sessions page, which has the room to name each; here it is noise on the
 * line an operator scans to tell a stuck server from a busy one.
 *
 * `limit` caps the number of TYPES, after the fold. Capping the raw buckets
 * instead displaced whole types to make room for repeats of one already
 * named — three Lock events pushed IO off a three-slot line. A Map keeps
 * first-seen order, so `running` stays first where the SQL put it.
 */
function activeWaitSummary(d: ActivityData, limit?: number): string {
  const byType = new Map<string, number>();
  for (const w of d.waits) byType.set(w.type, (byType.get(w.type) ?? 0) + w.sessions);
  const folded = [...byType];
  const list = (limit === undefined ? folded : folded.slice(0, limit))
    .map(([type, sessions]) => `${formatCount(sessions)} ${type}`).join(' · ');
  if (list) return list;
  return d.restricted ? 'restricted — own sessions only' : 'nothing executing';
}

/**
 * A band of related panels under one heading, with the route that goes deeper
 * into the same subject.
 *
 * The page was nine panels of identical weight in a single column, which gave
 * the reader no structure to navigate by and no way to tell which of the nine
 * this console is actually about. These four headings are the product's own
 * sentence — lock chains, slow queries, replication — made into the page's
 * skeleton, so the shape of the screen says what the tool is for before a
 * single value is read.
 *
 * The four bands are the four gates a request has to clear, in the order it
 * clears them: get a connection, get its locks, do the work, and be kept up
 * with afterwards. That ordering is not decoration — causes run DOWN it and
 * symptoms run UP it. Vacuum falling behind (gate 4) bloats tables, which
 * makes queries slow (gate 3), which piles up connections (gate 1). The thing
 * that pages you is near the top; the thing you have to fix is usually
 * further down.
 *
 * `subtitle` is that model, stated one sentence at a time and left on screen.
 * The bands used to be named `Saturation`, `Lock chains`, `Slow queries` and
 * `Replication`, which is three different vocabularies — a resource state, a
 * mechanism, and a symptom — so nothing told the reader they were the same
 * kind of thing, because they were not. Worse, none of the names matched the
 * TAB each one links to: `Saturation` went to Sessions and `Slow queries` to
 * Queries, so the page taught two names for everything. The titles now mirror
 * the tabs and the subtitle carries the meaning the old names were failing to.
 *
 * Within a band the panels are RANKED but the bands themselves are not: the
 * four always appear in the same order, so an operator who has used this page
 * before knows where to look before it renders. What changes is size, not
 * position. A check that needs attention takes a full-width card carrying its
 * explanation and its remedy; a healthy one collapses to a single line that
 * still shows its value and its badge. pgHero's dashboard does exactly this,
 * and the research is consistent that a responder holds five to nine items
 * before signal becomes noise — nine equal cards spent the whole budget
 * saying that a 42-minute lock chain and `0 slot(s)` were the same size of
 * problem.
 *
 * Ranking happens in the DOM, not in CSS `order`. A grid can reorder visually
 * while leaving the source sequence untouched, which would put the incident
 * first for a sighted reader and leave it fourth for everyone using a screen
 * reader or the Tab key — reintroducing exactly the visual/structure split
 * that the panel heading levels were fixed to close.
 */
function Band({
  gate,
  ordinal,
  href,
  linkLabel,
  panels,
  absorbed,
  hygiene,
}: {
  gate: Gate;
  /** Its place in the sequence, 1-based. See the spine, below. */
  ordinal: number;
  href?: string;
  linkLabel?: string;
  panels: PanelSpec[];
  /**
   * Every pid inside a loud lock chain (A17). Computed once in `Triage`,
   * because the chain is one fact shared by all four bands, and passed in
   * rather than derived here so a band cannot hold a different opinion
   * about it than its neighbours.
   *
   * Empty when the lock graph could not be read, or read fine and found
   * nothing, or found a chain that is not loud — see `Triage`.
   */
  absorbed: Set<number>;
  /**
   * The cached hygiene lines belonging to this band, already rolled up. A
   * band with none renders exactly as it did before they existed.
   */
  hygiene?: ReactNode;
}) {
  // Heading and subtitle come from gates.ts, not from this file. The bands
  // ARE the tree; there is no second place where their names are decided and
  // therefore no second place they can drift from.
  const { title, question } = GATES[gate];
  // A gate with nothing shipped against it yet renders nothing rather than an
  // empty heading. Unreachable today — all four have checks — and it exists
  // so that adding a gate ahead of its checks is not a visible defect.
  if (panels.length === 0) return null;
  // A panel is loud on its own verdict UNLESS it is corroborating one that is
  // already loud beside it. The Locks band is why: `blocked` counts the
  // waiters and `locks` walks the chain that produced them, so a single stuck
  // transaction escalated BOTH and the band rendered two full-width cards, two
  // red accent bars, and two four-line explanations that differed only in
  // wording — one of which, blocked.ts's, carries a comment acknowledging the
  // duplication and works around it by rephrasing rather than removing it.
  //
  // Two bars is the part that actually misleads. The accent bars exist to be
  // counted in peripheral vision before anything is read, so drawing two for
  // one incident overstates the page's own headline before the reader reaches
  // a single value.
  // Both sides must have RUN for one to corroborate the other. A check that
  // failed is never a supporting detail of anything: "we could not look" is
  // the state this whole console exists to keep distinct from a reading, and
  // two checks that failed differently are two different things to read, not
  // one incident seen twice. Demoting there also literally hid text — the
  // compact panel shows `reason` and drops `message`, so the sentence naming
  // what Postgres actually refused went missing.
  const escalated = new Set(
    panels.filter((p) => p.result.ok && needsAttention(p.result)).map((p) => p.title),
  );
  // A17: this panel's verdict is about a session the loud lock chain already
  // accounts for, so the chain is the incident and this is one of its
  // symptoms.
  //
  // No `p.result.ok` clause, unlike the `secondaryTo` one below, and the
  // difference is worth stating because the RULE is the same for both: a
  // check that failed is never a supporting detail of anything, and "we
  // could not look" must keep its own card and the message naming what
  // Postgres refused. Here that is already guaranteed by construction —
  // every `pid` on a spec is read off an `ok` result, so a failed check
  // carries `pid: null` and cannot match. Adding the clause anyway would be
  // an unreachable branch no test can hold, which this codebase treats as
  // prose in a type's clothing. The behaviour is pinned by the
  // failed-check test on the page instead.
  const inChain = (p: PanelSpec) => p.pid != null && absorbed.has(p.pid);
  const isLoud = (p: PanelSpec) =>
    needsAttention(p.result) &&
    !inChain(p) &&
    !(p.secondaryTo !== undefined && p.result.ok && escalated.has(p.secondaryTo));
  const loud = panels.filter(isLoud);
  const quiet = panels.filter((p) => !isLoud(p));

  return (
    // THE SPINE. A fixed column carrying the gate, and the panels beside it.
    //
    // The four bands are a SEQUENCE — the gates a request clears, in the
    // order it clears them — and the page has always known that and never
    // shown it. Four headings down a single column say "here are four
    // groups"; a numbered rail down the left says "here is a path, and this
    // is where it broke". That is the model this console is built on, and it
    // is the one thing here no other tool can draw, because no other tool has
    // it.
    //
    // Numbered, which this project otherwise avoids: 01/02/03 on a page is
    // decoration unless the content really is ordered, and here it is. Causes
    // run DOWN the numbers and symptoms run UP them — vacuum falling behind
    // (4) bloats tables, which slows queries (3), which piles up connections
    // (1) — so the number is the direction to read in, not a label.
    //
    // Below `lg` it collapses to exactly what it was: heading, question,
    // panels. The rail is worth a 14rem column on a monitor and is worth
    // nothing on a phone, and this console is opened on both.
    <section className="grid gap-x-8 gap-y-3 border-t pt-5 first:border-t-0 first:pt-0 lg:grid-cols-[14rem_1fr]">
      {/* The grid stretches this cell to the band's full height, which is
          what makes the rule a rail rather than a stub beside the heading. */}
      <div className="lg:border-r lg:pr-8">
        <div className="flex items-baseline gap-2.5">
          <span aria-hidden="true" className="text-sm tabular-nums text-muted-foreground">{ordinal}</span>
          <h2 className="text-xl font-medium">{title}</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{question}</p>
        {href ? (
          // The word, not an arrow. A link that says "Sessions" is already a
          // direction; `→` only repeats what underlined blue text says.
          <Link
            href={href}
            className="mt-2 inline-block text-sm underline-offset-4 hover:underline"
          >
            {linkLabel}
          </Link>
        ) : null}
      </div>
      {/* `content-start`: the grid row is as tall as the taller of the gate
          cell and the panels, and without this the panels stretch to fill it
          — which put each healthy row's hairline forty pixels below the words
          it belongs to, reading as a box with nothing in it. */}
      <div className="grid content-start gap-2">
        {loud.map((p) => (
          // `data-loud` carries the title of every panel this band spent a
          // full card on. A17 is a claim about HOW MANY cards one incident
          // gets, and counting rendered cards is the only way to assert it:
          // a test that looks for the presence of a panel passes just as
          // well when five of them are loud, which is the defect.
          <div key={p.title} id={p.anchor} data-loud={p.title}>
            <CheckPanel headingLevel={3} title={p.title} result={p.result}>
              {(d, v) => p.render(d, v)}
            </CheckPanel>
          </div>
        ))}
        {quiet.length > 0 ? (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {quiet.map((p) => (
              <CheckPanel key={p.title} headingLevel={3} title={p.title} result={p.result} compact>
                {(d, v) => (
                  <>
                    {p.summary ? p.summary(d) : p.render(d, v)}
                    {/*
                      A17: five words saying why this reading is small. Without
                      it the fold is indistinguishable from the panel simply
                      being healthy, which would hide a real finding — the
                      opposite of the problem it was added to solve.
                    */}
                    {inChain(p) ? (
                      <span>
                        {' · '}
                        <Link href="#lock-wait-graph" className="underline underline-offset-4">in this chain</Link>
                      </span>
                    ) : null}
                  </>
                )}
              </CheckPanel>
            ))}
          </div>
        ) : null}
        {/* Last in the band, below the live panels: these are findings from
            the last capture, not from this render. */}
        {hygiene}
      </div>
    </section>
  );
}

/**
 * Where the qualitative bands on the Connections bullet graph start.
 *
 * Derived from the check's own thresholds rather than written out again, so
 * the picture and the verdict cannot disagree: retune `connections.ts` and
 * the shading moves with it. The thresholds are stated as PERCENT HEADROOM
 * REMAINING and the graph is drawn in the other direction — occupancy — so
 * `100 - value` is the conversion, and it is exact rather than approximate
 * because `headroom = max - reserved - used`, which makes occupancy exactly
 * `max - headroom`.
 */
const CONNECTION_BANDS = (CHECKS.connections.thresholds ?? [])
  .filter((t) => t.unit === 'percent')
  .map((t) => ({ from: 100 - t.value, level: t.level }));

export default async function Triage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  const [
    connections, sessionStates, blocked, activity, longRunning, locks, wraparound, horizon, slots,
    queryStats, replication, standbyList, throughput, hygiene,
  ] = await Promise.all([
      runCheckFor(name, CHECKS.connections),
      runCheckFor(name, CHECKS.sessionStates),
      runCheckFor(name, CHECKS.blocked),
      // Task 1: what the server is doing right now, ahead of Long-running —
      // see registry.ts and checks/activity.ts for why it carries no verdict.
      runCheckFor(name, CHECKS.activity),
      runCheckFor(name, CHECKS.longRunning, {}),
      runCheckFor(name, CHECKS.locks),
      runCheckFor(name, CHECKS.wraparound),
      runCheckFor(name, CHECKS.horizon),
      runCheckFor(name, CHECKS.slots),
      runCheckFor(name, CHECKS.queryStats, { sort: 'total' }),
      runCheckFor(name, CHECKS.replicationLag),
      // B4: the only replication JUDGEMENT this gate has. `replicationLag`
      // carries no threshold, so a standby arbitrarily far behind never
      // escalated the band titled "can the server keep up".
      runCheckFor(name, CHECKS.standbys),
      // Task 2: commits, rollbacks, deadlocks and temp spill since the last
      // poll — also carries no verdict (see database-activity.ts), so it
      // joins activity and horizon above rather than the `results` list below.
      runCheckFor(name, CHECKS.databaseActivity),
      // Beside the checks, not after them: it is one indexed read of the
      // store, and serialising it would add its latency to every poll.
      hygieneFor(name),
    ]);
  // sampledAt is the server's own clock, read in the same statement as the
  // counters `throughput` just carried — see lib/rates.ts for why that
  // matters and ratesFor's own module-level Map for why this needs no store.
  const rates = ratesFor(name, throughput);

  // When the database itself is gone, all nine checks fail with the SAME
  // reason and the SAME message, and the page rendered that message nine
  // times inside a full band structure — as if there were something here to
  // triage. The one fact that matters ("this database is unreachable, and
  // here is what Postgres said") was the least prominent thing on the screen,
  // buried in eight repetitions of itself.
  //
  // Only collapsed when the failures are genuinely IDENTICAL. A page where
  // some checks failed for different reasons — one denied, one needing an
  // extension — is a page where each panel is saying something different, and
  // there the per-panel rendering is exactly right.
  const results = [connections, sessionStates, blocked, longRunning, locks, wraparound, slots, queryStats, replication, standbyList];
  const failures = results.filter((r) => !r.ok);
  // `\0` and not a space: a space is ambiguous between reason "a" + message
  // "b c" and reason "a b" + message "c", which would call two different
  // failures identical and collapse a page that should have shown both. It
  // is the ESCAPE, not a literal NUL byte in this file — a raw one here made
  // `file` report this source as binary data and made grep skip it entirely.
  const alike = new Set(failures.map((f) => `${f.reason}\0${f.message}`));
  const shared = failures.length === results.length && alike.size === 1 ? failures[0] : null;

  if (shared) {
    return (
      <div className="grid gap-4">
        <div className="flex justify-end"><Refresh intervalMs={5_000} /></div>
        <section className="rounded-lg border border-l-4 border-l-destructive p-4">
          <header className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <h2 className="font-semibold">{name} is unreachable</h2>
            <Badge variant="outline">UNAVAILABLE</Badge>
          </header>
          <p className="text-sm">
            None of the {formatCount(results.length)} checks on this page could run — every one of
            them failed the same way, so this is the database or the connection rather than any
            single check.
          </p>
          <p className="mt-2 text-sm font-medium">{shared.reason}</p>
          <p className="text-sm text-muted-foreground">{shared.message}</p>
          {shared.remedy ? (
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 text-sm">{shared.remedy}</pre>
          ) : null}
          <p className="mt-3 text-sm text-muted-foreground">
            The page keeps polling; Refresh retries now. Check the connection string for this
            database in <code>PGOPS_DATABASES</code> if it does not come back.
          </p>
        </section>
      </div>
    );
  }

  // See lib/stuck.ts. Empty when the lock check could not run, which
  // degrades to exactly the old behaviour — every long-running query treated
  // as slow — rather than to a claim that nothing is blocked.
  //
  // Every long-running query on the page being a waiter means there is no
  // separately slow query here at all — and the threshold's remedy
  // ("terminating this backend usually frees work nobody is waiting for") is
  // then false of every row it is sitting next to. Dropping `crossed` is how
  // that guidance is withheld, because that is the field CheckPanel renders
  // it from. Not a lie by omission: the panel says in its own words what is
  // going on instead, and it says something the check could not have known —
  // the check sees one catalog, the page sees two. The verdict and its badge
  // are untouched, because "this query has been running 18m" remains true
  // and remains worth escalating.
  const { blockedBy, allStuck, longRunning: longRunningResult, locksUnavailable } = stuckFrom(longRunning, locks);

  /**
   * A17: every pid the lock chain accounts for, when there IS a loud chain.
   *
   * Three conditions, each load-bearing. `locks.ok`, because a fold keyed on
   * a graph this console could not read would demote real verdicts on the
   * strength of nothing. `needsAttention`, because a chain the page is not
   * spending a card on is not a card for anything to fold under — the
   * folded lines link to it. And computed HERE, once, so all four bands
   * share one answer rather than each deriving its own.
   */
  const chain = locks.ok && needsAttention(locks) ? chainPids(locks) : new Set<number>();

  // The tab each band goes deeper into. Keyed by gate so a band cannot be
  // given the wrong link, and partial because `keep-up` has no route of its
  // own yet — P2's hygiene page is where it will point.
  const LINKS: Partial<Record<Gate, { href: string; label: string }>> = {
    connect: { href: `/db/${name}/sessions`, label: 'Sessions' },
    wait: { href: `/db/${name}/locks`, label: 'Wait graph' },
    work: { href: `/db/${name}/queries`, label: 'All queries' },
    // The fourth gate had no link, which was invisible while the bands were
    // headings and obvious the moment each one got a cell with a slot for it.
    'keep-up': { href: `/db/${name}/cleanup`, label: 'Cleanup' },
  };

  // Every panel on this page, flat. Which BAND each one lands in is not
  // decided here — `panel` copies the gate off the check, and the render
  // loop below groups by it. Moving a check to another gate moves its
  // panel, with nothing in this file to keep in step.
  const panels: PanelSpec[] = [

    panel(CHECKS.connections, 'Connections', connections, (d) => (
      <div className="grid gap-2">
        {/* Drawn as occupancy, and labelled as occupancy. `used` alone
            would not match the bar, because the superuser reserve is
            neither used nor free — it is headroom this check has
            already refused to count, and the graph must agree with the
            arithmetic that produced the verdict. */}
        <Bullet value={d.max - d.headroom} max={d.max} bands={CONNECTION_BANDS} />
        <p className="text-sm">
          <span className="font-medium text-foreground">{formatCount(d.used)}</span>
          <span className="text-muted-foreground">
            {' '}used · {formatCount(d.reserved)} reserved · {formatCount(d.headroom)} free
            {' '}of {formatCount(d.max)}
          </span>
        </p>
      </div>
    ), (d) => (
      <span>{formatCount(d.used)} used · {formatCount(d.headroom)} free of {formatCount(d.max)}</span>
    )),

    /*
      Plan defect (see task-8-report.md): the brief's Sessions panel read
      `d.states` with `{state, count, longestSecs}` per entry. The real
      `StatesData` shape (packages/checks/src/checks/sessions.ts) is
      `{ byState: {state, sessions, longestInStateSecs}[], oldestIdleInTxnSecs }`
      — corrected below to the compiler-verified field names.
    */
    {
      // A17: the session this verdict is about — B12 is what made it
      // available. When it is the chain's root, this panel is the chain seen
      // from gate 1 and folds under it.
      ...panel(CHECKS.sessionStates, 'Sessions by state', sessionStates, (d) => {
      // One shared scale across every row, which is the entire reason
      // these are bars and not a stacked bar. Grafana's guidance is to
      // turn stacking off in most cases because it hides data, and the
      // reason is that stacked segments do not share a baseline — only
      // the bottom one can be compared by length. Aligned bars against
      // a common maximum are the encoding people actually read
      // accurately.
      const peak = Math.max(1, ...d.byState.map((s) => s.sessions));
      return (
        <>
        <ul className="grid gap-1.5 text-sm">
          {d.byState.map((s) => (
            // Every column FIXED except the track.
            //
            // This was `[9rem_1fr_auto]`, and `auto` sizes to its own
            // content: "17 · 2s" is narrower than "6 · 6m 17s", so the
            // third column changed width per row and the `1fr` track
            // changed with it. Each bar was then drawn to 100% of a
            // DIFFERENT length, which destroys the only thing aligned
            // bars are for — a shared baseline is what makes length
            // comparable, and without it the longest bar was merely the
            // row with the shortest label.
            <li key={s.state} className="grid grid-cols-[8rem_1fr_8rem] items-center gap-3">
              <span className="truncate">{s.state}</span>
              <Bullet value={s.sessions} max={peak} />
              <span className="text-right tabular-nums text-muted-foreground">
                {formatCount(s.sessions)} · {formatDuration(s.longestInStateSecs)}
              </span>
            </li>
          ))}
        </ul>
          {/*
            B12: the session the verdict is about, reachable rather than
            described. The threshold's remedy used to end "Sessions shows its
            application_name", which sent an operator to go and look up an
            identity this check already had and threw away.

            Rendered only when there IS one: on a healthy database this panel
            is a census and names nobody.
          */}
          {d.oldestIdleInTxnPid === null ? null : (
            <p className="mt-2 text-sm text-muted-foreground">
              <Link href={`/db/${name}/sessions#pid-${d.oldestIdleInTxnPid}`} className="font-mono underline underline-offset-4">
                {d.oldestIdleInTxnPid}
              </Link>
              {d.oldestIdleInTxnApp === null ? '' : ` ${d.oldestIdleInTxnApp}`}
              {' '}is the oldest idle in transaction
            </p>
          )}
        </>
      );
    }, (d) => (
      <span>{d.byState.map((s) => `${formatCount(s.sessions)} ${s.state}`).join(' · ') || 'no sessions'}</span>
      )),
      pid: sessionStates.ok ? sessionStates.data.oldestIdleInTxnPid : null,
    },

    /*
      Plan defect (see task-8-report.md): the brief's Wraparound panel read
      `d.pctToForcedVacuum` directly off `WraparoundData`. The real shape is
      `{ worst: WraparoundEntry[] }` — one entry per database, worst first —
      so `pctToForcedVacuum` lives on `d.worst[0]`, which can be absent (an
      empty `pg_database`, unreachable in practice but not unrepresentable).
    */
    // Gate 4, not gate 1. This sat beside Connections for a long time on the
    // reasoning that both measure "how much room is left before the server
    // stops accepting work" — true, and it put the panel a gate away from the
    // only thing that can be done about it. A wraparound horizon closes
    // because VACUUM is not keeping up, which is gate 4's whole subject, and
    // P2's autovacuum and vacuum-progress panels will land beside it there.
    // The move was one word in wraparound.ts; this file was not touched.
    panel(CHECKS.wraparound, 'Wraparound', wraparound, (d) => {
      const worst = d.worst[0];
      if (!worst) return <p className="text-sm text-muted-foreground">No databases reporting.</p>;
      return (
        <div className="grid gap-2">
          <Bullet value={worst.pctToForcedVacuum} max={100} />
          <p className="text-sm">
            <span className="font-medium">{worst.database}</span>
            <span className="text-muted-foreground">
              {' '}· {worst.pctToForcedVacuum}% of horizon ·{' '}
              {formatCount(worst.txnsUntilShutdown)} txns left
            </span>
          </p>
        </div>
      );
    }, (d) => {
      const worst = d.worst[0];
      // No bullet here. A healthy wraparound reading is 0% of the
      // horizon, and a bar drawn at 0% is an empty grey track that
      // reads as a graphic that failed to load rather than as good news.
      return <span>{worst ? `${worst.database} · ${worst.pctToForcedVacuum}% of horizon` : 'none reporting'}</span>;
    }),

    // Deliberately names NO pid, though the check offers one.
    //
    // `blocked.suspectPid` is `pg_blocking_pids(pid)[1]` of the
    // longest-waiting session — the waiter's IMMEDIATE blocker, which
    // in any chain longer than two is itself a waiter. Live example:
    // 9401 blocks 9403 blocks 9402, so the root is 9401 and
    // `suspectPid` is 9403. This panel rendered "suspect pid 9403"
    // directly above a remedy reading "terminate the ROOT blocker, not
    // a waiter", and beside a Lock wait graph panel naming 9401 —
    // three answers to "which pid do I kill", two of them wrong, on the
    // console's own incident screen.
    //
    // So exactly one panel on this page names an actionable pid, and it
    // is the one that walks the graph. This one answers how bad it is.
    //
    // And it is `secondaryTo` the wait graph. Both checks escalate off
    // the same stuck transaction — one counts its waiters, the other
    // walks the chain that made them wait — so during any lock incident
    // this band drew two red bars and two paragraphs of near-identical
    // advice for one problem. The count and the longest wait are worth
    // keeping and are not worth a card: they are how BAD, and the panel
    // beside them is WHO, which is the one an operator can act on.
    {
      ...panel(CHECKS.blocked, 'Blocked', blocked, (d) =>
        d.count === 0
          ? <span>Nothing waiting on a lock.</span>
          : (
            <p>
              {formatCount(d.count)} waiting · longest {formatDuration(d.longestQueryAgeSecs)} ·{' '}
              <Link href={`/db/${name}/locks`} className="underline underline-offset-4">
                see the chain
              </Link>
            </p>
          ),
        (d) =>
          d.count === 0
            ? <span>Nothing waiting.</span>
            : <span>{formatCount(d.count)} waiting · longest {formatDuration(d.longestQueryAgeSecs)}</span>,
      ),
      secondaryTo: 'Lock wait graph',
    },

    {
      // A17: the card the folded lines link to. The chain is the incident;
      // every panel that folds is a view of it from another gate.
      ...panel(CHECKS.locks, 'Lock wait graph', locks, (d) => {
      // `1 root blocker(s)` was this panel's entire output, on the one
      // subject the product's own one-line pitch leads with. A count of
      // root blockers is the least useful fact about them: the operator
      // needs to know WHICH session to act on, and the answer — pid,
      // role, application, and whether it is even running a query — is
      // sitting in `roots[0]` and was being thrown away. The Locks page
      // one click below already renders exactly this, which is the
      // proof it was a presentation choice and not missing data.
      const root = d.roots[0];
      if (!root) return <span>No blocking.</span>;
      return (
        <div className="text-sm">
          <p>
            {/* The one pid on this page presented as actionable, and
                the one the remedy means: Sessions is where it ends. */}
            <Link href={`/db/${name}/sessions#pid-${root.pid}`} className="font-mono font-medium underline underline-offset-4">
              {root.pid}
            </Link>
            <span className="text-muted-foreground">
              {' '}{root.user ?? '—'}@{root.app || '—'} · {root.state ?? 'unknown state'}
              {' '}· blocking {formatCount(root.totalWaiters)}
              {root.xactAgeSecs === null ? '' : ` · open ${formatDuration(root.xactAgeSecs)}`}
            </span>
          </p>
          <div className="mt-1"><Sql>{root.query}</Sql></div>
          {d.roots.length > 1 ? (
            <p className="mt-1 text-muted-foreground">
              and {plural(d.roots.length - 1, 'more root blocker')}.
            </p>
          ) : null}
        </div>
      );
    }, (d) => (
      <span>{d.roots.length === 0 ? 'No blocking.' : plural(d.roots.length, 'root blocker')}</span>
      )),
      anchor: 'lock-wait-graph',
    },

    panel(CHECKS.activity, 'Active now', activity, (d) => (
      <span>{formatCount(d.active)} active · {activeWaitSummary(d)}</span>
    ), (d) => (
      <span>{formatCount(d.active)} active · {activeWaitSummary(d, 3)}</span>
    )),

    {
      // A17: folds only when EVERY row is a waiter, which is `allStuck`.
      //
      // Keying this on the first row's pid alone was wrong, and the existing
      // mixed-list test caught it: with one genuinely slow query and one
      // waiter in the panel, the chain does not explain the panel, and
      // folding it dropped the remedy that is correct for the slow one. That
      // is the same mixed case the per-row "blocked by" markers below exist
      // for, one level up.
      //
      // When `allStuck` does hold, `stuckFrom` has already rewritten the
      // verdict to name the root, and the five-word link replaces the
      // paragraph that used to explain the same thing.
      ...panel(CHECKS.longRunning, 'Long-running', longRunningResult, (d) =>
      d.queries.length === 0
        ? <span>No long-running queries.</span>
        : (
          <>
            {/* Above the rows, not only in the Lock wait graph band above:
                this panel is the one whose rows lose their "blocked by"
                marks when the wait graph cannot be read, and an operator
                reading this band alone would see plain durations with
                nothing connecting the absence to a failure elsewhere on the
                page. Copy kept identical to the Sessions page's caveat —
                same console, same fact, one sentence. */}
            {locksUnavailable === null ? null : (
              <p className="mb-2 max-w-prose text-sm">
                <span className="font-medium">Cannot tell which of these are waiting — {locksUnavailable}. </span>
                <span className="text-muted-foreground">
                  The lock wait graph could not be read, so no row here is marked "blocked by"
                  and this console cannot say whether these sessions are working or queued behind
                  one another. Terminating them may kill sessions that would have finished on
                  their own.{' '}
                </span>
                <Link href={`/db/${name}/locks`} className="underline underline-offset-4">Locks</Link>
                <span className="text-muted-foreground"> has the reason.</span>
              </p>
            )}
            <ul className="grid gap-2 text-sm">
              {d.queries.map((q) => {
                const root = blockedBy.get(q.pid);
                return (
                  <li key={q.pid}>
                    {/* `pid · facts`, inline and left-aligned, which is
                        the format the Lock wait graph panel above
                        already uses for the same kind of line. This was
                        `flex justify-between`, pinning the duration to
                        the far right of the panel — tolerable while the
                        guidance column took half the width, and absurd
                        once a panel with no guidance to show ran the
                        full 1400px: a pid at one edge and its own
                        duration at the other, with nothing in between
                        to carry the eye across. */}
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      {/* Same reasoning as the suspect pid above: a pid this
                          page flags as a problem should be one click from
                          the row that can end it. */}
                      <Link href={`/db/${name}/sessions#pid-${q.pid}`} className="font-mono underline underline-offset-4">
                        {q.pid}
                      </Link>
                      <span className="text-muted-foreground">
                        {/* Marked per ROW, not only in the sentence
                            below, because the mixed case is the one that
                            misleads: with one genuinely slow query and
                            one waiter in the same list, a note under the
                            list cannot say which is which, and the
                            remedy beside it — correct for the slow one —
                            is wrong for the other. */}
                        {root === undefined ? null : (
                          <>blocked by <span className="font-mono">{root}</span> · </>
                        )}
                        {formatDuration(q.runningSecs)}
                      </span>
                    </p>
                    {/* The query itself, which this panel used to omit. A
                        pid and a duration cannot be judged: "2317, 42m" is
                        alarming for an OLTP statement and completely
                        ordinary for a nightly report, and the text is the
                        only thing that says which this is. */}
                    <Sql>{q.query}</Sql>
                  </li>
                );
              })}
            </ul>
            {allStuck ? (
              <p className="mt-3 max-w-prose text-sm">
                <span className="font-medium">Not slow — waiting. </span>
                <span className="text-muted-foreground">
                  Every query here is queued behind the lock chain above, so these
                  durations are time spent waiting rather than time spent working.
                  Terminating one frees nothing and the next takes its place; the
                  session to act on is the root blocker under{' '}
                </span>
                <Link href={`/db/${name}/locks`} className="underline underline-offset-4">
                  Locks
                </Link>
                <span className="text-muted-foreground">.</span>
              </p>
            ) : null}
          </>
        ),
      // A17: a compact line, which this panel did not have.
      //
      // `summary` was `undefined`, and a panel with no summary keeps its
      // full renderer in the compact slot (see the `panel` docblock). So the
      // first fold of this panel put two rows of pids and two statements
      // into a one-line cell: the accent bar went away and the HEIGHT did
      // not, which is half the defect A17 is about. Found by driving it, not
      // by a test — jsdom computes no layout.
      (d) => (
        <span>
          {d.queries.length === 0
            ? 'none'
            // `statement`, not `query`: the redaction guard matches the whole
            // word `query` inside any brace span that RENDERS, and it is
            // right to — the space of spellings that leak a statement is
            // open, so the guard cannot afford to know this one is a count.
            // The word is no worse here either way.
            : `${plural(d.queries.length, 'statement')} · longest ${formatDuration(
                Math.max(...d.queries.map((q) => q.runningSecs)),
              )}`}
        </span>
      ),
      ),
      pid: allStuck && longRunningResult.ok ? longRunningResult.data.queries[0]?.pid ?? null : null,
    },

    panel(CHECKS.queryStats, 'Query statistics', queryStats, (d) => {
      // `53 statement shape(s)` was the whole panel: a number that
      // changes nothing an operator does, occupying a full card on the
      // triage screen. The shapes are already sorted by total time —
      // the page asks for `sort: 'total'` — so the worst one is
      // `rows[0]` and naming it costs nothing.
      const worst = d.rows[0];
      if (!worst) {
        return <span>{formatCount(d.totalShapes)} shapes · nothing notable.</span>;
      }
      return (
        <div className="text-sm">
          <p className="text-muted-foreground">
            worst of {formatCount(d.totalShapes)} shapes ·{' '}
            {formatMillis(worst.totalMs)} total · {formatMillis(worst.meanMs)} mean ·{' '}
            {formatCount(worst.calls)} calls
          </p>
          <div className="mt-1"><Sql>{worst.query}</Sql></div>
        </div>
      );
    }, (d) => {
      // No query text when compact. On a console whose store lives in
      // the database it is watching, the heaviest shape is routinely
      // one of pgops's own catalog reads — pg_stat_statements records
      // no application_name, so it cannot be told apart from the
      // application's work, and putting it on the triage screen as
      // "the worst query" would be the console pointing at itself.
      const worst = d.rows[0];
      return <span>{formatCount(d.totalShapes)} shapes{worst ? ` · worst ${formatMillis(worst.totalMs)} total` : ''}</span>;
    }),

    // Task 2: commits, rollbacks, deadlocks and temp spill since the last
    // poll. Compact-only by construction — `Throughput` (shared with the
    // Queries page, components/throughput.tsx) is the only renderer this
    // panel is given, so it never spends a full card even while escalated;
    // a deadlock count is still carried in the critical ink inside it.
    panel(CHECKS.databaseActivity, 'Throughput', throughput,
      () => <Throughput rates={rates} />,
      // The compact line is `Throughput compact`, not a span written here.
      // This WAS such a span, and B11's own-share clause consequently
      // reached the loud panel and the Queries page but not the one line
      // this band actually renders — see the component's docblock.
      () => <Throughput rates={rates} compact />),

    {
      // A17: the pid pinning the horizon, when a BACKEND is what pins it. A
      // slot or a prepared transaction is not a session and no chain
      // explains it, so those keep their own card.
      ...panel(CHECKS.horizon, 'Oldest snapshot', horizon, (d) => {
      // The furthest-back holder, whatever kind it is — same ranking the
      // check's own verdict uses, so the panel never names a different
      // holder than the one that set the badge.
      const worst = d.holders[0];
      if (!worst) return <span>Nothing pinned.</span>;
      return (
        <p className="text-sm">
          {worst.kind === 'backend'
            ? (
              <Link href={`/db/${name}/sessions#pid-${worst.who}`} className="font-mono underline underline-offset-4">
                {worst.who}
              </Link>
            )
            : <span className="font-mono">{worst.who}</span>}
          <span className="text-muted-foreground">
            {' '}{worst.kind} pins the horizon {formatCount(worst.xminAge)} transactions back
            {worst.ageSecs === null ? '' : ` · open ${formatDuration(worst.ageSecs)}`}
          </span>
        </p>
      );
    }, (d) => {
      const worst = d.holders[0];
      return (
        <span>
          {worst
            ? `oldest snapshot ${formatCount(worst.xminAge)} transactions${worst.kind === 'backend' ? ` · pid ${worst.who}` : ` · ${worst.kind} ${worst.who}`}`
            : 'nothing pinned'}
        </span>
      );
      }),
      pid: horizon.ok && horizon.data.holders[0]?.kind === 'backend'
        ? Number(horizon.data.holders[0].who)
        : null,
    },

    // B4: NOT `secondaryTo: 'Role and lag'`. The two measure different
    // things — that one is this server's view of itself, this one is its
    // view of everything streaming from it — so one being loud says nothing
    // about whether the other should be.
    panel(CHECKS.standbys, 'Standbys', standbyList, (d) => (
      <ul className="grid gap-1 text-sm">
        {d.standbys.length === 0
          ? <li className="text-muted-foreground">No standbys are streaming from this server.</li>
          : d.standbys.map((sb) => (
            <li key={`${sb.app}-${sb.clientAddr ?? 'local'}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono">{sb.app}</span>
              <span className="text-muted-foreground">
                {sb.state ?? 'state unknown'}
                {' · replay '}
                {/* Em dash, never a zero — see the check's own note. */}
                {sb.replaySecs === null ? '—' : formatDuration(sb.replaySecs)}
                {sb.replayBytes === null ? '' : ` · ${formatBytes(sb.replayBytes)} behind`}
              </span>
            </li>
          ))}
      </ul>
    ), (d) => {
      const timed = d.standbys.filter((sb) => sb.replaySecs !== null);
      let worst = 0;
      for (const sb of timed) if (sb.replaySecs !== null && sb.replaySecs > worst) worst = sb.replaySecs;
      return (
        <span>
          {d.standbys.length === 0
            ? 'no standbys'
            : timed.length === 0
              ? `${plural(d.standbys.length, 'standby', 'standbys')} · replay unknown`
              : `${plural(d.standbys.length, 'standby', 'standbys')} · worst replay ${formatDuration(worst)}`}
        </span>
      );
    }),

    panel(CHECKS.replicationLag, 'Role and lag', replication, (d) => (
      <span>
        {/* B4: `receiving` first — a dead walreceiver reads 0s behind. */}
        {d.inRecovery === null
          ? 'role unknown'
          : d.inRecovery
            ? d.receiving === false
              ? 'standby · NOT RECEIVING'
              : d.lagSeconds === null
                ? 'standby · nothing replayed yet'
                : `standby · ${formatDuration(d.lagSeconds)} behind`
            : 'primary'}
        {/*
          Stage 4's re-plan overlap: this clause and the Standbys panel
          above it said one fact twice — "no standbys" over
          "primary · 0 streaming". Withheld rather than deleted, because
          `standbys` requires pg_monitor and this check requires nothing, so
          a restricted role has this as its only reading of the count. The
          specialist owns the fact when it can report it.
        */}
        {standbyList.ok ? null : (
          <>
            {' · '}
            {d.standbys === null ? 'standbys unknown' : `${formatCount(d.standbys)} streaming`}
          </>
        )}
      </span>
    )),

    panel(CHECKS.slots, 'Replication slots', slots, (d) => {
      // `0 slot(s)` again told the operator nothing they could act on.
      // A slot matters for exactly two reasons — whether anything is
      // consuming it, and how much WAL it is holding — and both are on
      // the record already.
      if (d.slots.length === 0) return <span>None configured.</span>;
      const worst = [...d.slots].sort((a, b) => (b.retainedBytes ?? 0) - (a.retainedBytes ?? 0))[0]!;
      return (
        <span>
          <span className="font-medium">{worst.name}</span>
          {' · '}{worst.active ? 'active' : 'INACTIVE'}
          {worst.retainedBytes === null ? '' : ` · ${formatBytes(worst.retainedBytes)} retained`}
          {d.slots.length > 1 ? ` · ${formatCount(d.slots.length)} slots` : ''}
        </span>
      );
    }),
  ];

  // One line per hygiene area, in the band its page belongs to. `band` comes
  // from AREAS rather than from each check's gate, because the two are
  // allowed to disagree: `invalidConstraints` answers a keep-up question and
  // renders on the Indexes page, which is a work page.
  const byBand = new Map<Gate, HygieneArea[]>();
  if (hygiene.ok) {
    for (const area of hygiene.areas) {
      if (area.band === null) continue;
      byBand.set(area.band, [...(byBand.get(area.band) ?? []), area]);
    }
  }

  return (
    <div className="grid gap-5">
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="flex justify-end"><Refresh intervalMs={5_000} /></div>

      {GATE_ORDER.map((gate, i) => (
        <Band
          key={gate}
          gate={gate}
          ordinal={i + 1}
          href={LINKS[gate]?.href}
          linkLabel={LINKS[gate]?.label}
          panels={panels.filter((p) => p.gate === gate)}
          absorbed={chain}
          hygiene={<HygieneBand name={name} areas={byBand.get(gate) ?? []} />}
        />
      ))}

      {/* Said ONCE, at the foot of the page, not four times in four bands:
          it is one fact about the deployment, not a finding about a band. */}
      {hygiene.ok ? null : (
        <p className="text-sm text-muted-foreground">
          Index, table and sequence checks are not shown. {hygiene.message}
        </p>
      )}
    </div>
  );
}

/** The cached lines for one band, or nothing at all when it has none. */
function HygieneBand({ name, areas }: { name: string; areas: HygieneArea[] }) {
  if (areas.length === 0) return null;
  return (
    // The same columns as the quiet panels above them, so the two groups
    // share a grid rather than each having their own.
    <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {areas.map((a) => <HygieneLine key={a.id} area={a} name={name} />)}
    </div>
  );
}
