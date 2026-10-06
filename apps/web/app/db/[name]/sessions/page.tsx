import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, LONG_RUNNING_FLOOR_SECS, grantRemedy, type ActivityData, type AuditRecord } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { APP_NAME } from '@/lib/config';
import { actionsAllowed } from '@/lib/actions';
import { foldFrom } from '@/lib/fold';
import { stuckFrom, type Stuck } from '@/lib/stuck';
import { recentActionsFor } from '@/lib/recent-actions';
import { CheckPanel } from '@/components/check-panel';
import { KillButton } from '@/components/kill-button';
import { ConfirmAction } from '@/components/confirm-action';
import { Refresh } from '@/components/refresh';
import { Sql } from '@/components/sql';
import { formatAgo, formatCount, formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HighlightedRow } from '@/components/row-highlight';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Sessions` };
}

export default async function Sessions({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ limit?: string; pgops?: string }>;
}) {
  const { name } = await params;
  const { limit, pgops } = await searchParams;
  // The same fold the hygiene lists use, on a different subject: there it is
  // pgops's own relations, here its own connections. The rule that the state
  // lives in the URL and that every other parameter travels with it is
  // shared — see lib/fold.ts.
  const fold = foldFrom(`/db/${name}/sessions`, { limit, pgops });
  const parsed = Number(limit);
  // Promise.all, not two sequential awaits: this is the one page whose
  // entire subject is the live connection picture, and two serialized round
  // trips are two snapshots of pg_stat_activity taken at different instants
  // — on a page that already re-fetches every 5 seconds. Every other
  // multi-check page (app/page.tsx, app/db/[name]/page.tsx) does the same.
  const [result, detail, active, running, locks, recent] = await Promise.all([
    runCheckFor(name, CHECKS.sessions, {
      limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    }),
    runCheckFor(name, CHECKS.connectionDetail, {}),
    // Task 1: what the server is doing right now — CPU-bound or waiting on
    // disk, one shape or forty. Fetched beside the others for the same reason
    // they all are: this page's whole subject is a live snapshot, and a
    // second round trip is a second, different instant.
    runCheckFor(name, CHECKS.activity),
    // #12's diagnosis. Fetched beside the others for the same reason they are
    // fetched together: two serialized round trips are two snapshots of
    // pg_stat_activity taken at different instants.
    runCheckFor(name, CHECKS.longRunning, {}),
    // Task 1: the same join the triage page makes, made here too — a session
    // blocked on a lock is `active` in pg_stat_activity, so every waiter is
    // ALSO a long-running query. Without this, this page — the one with the
    // actual Terminate buttons — offered to terminate the waiters while the
    // triage page one click away said killing a waiter frees nothing. See
    // lib/stuck.ts.
    runCheckFor(name, CHECKS.locks),
    // Task 5: feedback after a kill. Fetched beside the others for the same
    // reason — this is the one page whose subject is a live snapshot, and
    // the audit trail is read-only disk I/O, not a query against this
    // server, so it carries no extra load on the database being watched.
    recentActionsFor(name),
  ]);
  // Read here, after runCheckFor has already awaited connection() — so this
  // page is dynamic before the gate is read, and the gate reflects the
  // deployment rather than being frozen at build time. Not hoisted to module
  // scope; see lib/check.ts and test/guards.test.ts.
  const canAct = actionsAllowed(process.env);
  const stuck = stuckFrom(running, locks);

  return (
    <>
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="mb-2 flex justify-end"><Refresh intervalMs={5_000} /></div>
      {/* A19: the table that can END the incident comes first, and the three
          panels that DESCRIBE it follow. Measured at 390x844 with a seeded
          lock chain, the first Terminate button was 1292px down this page —
          one and a half screens — because Active now, Long-running and
          Recent actions all sat above the rows that carry the control.

          Not folded the way A17 folded the triage panels: that fold works
          because the Lock wait graph is on the same screen for a collapsed
          card to point at, and this page has no wait graph. These panels are
          not echoes of something above them, they were simply above the
          thing an operator came for. Order is held by test/sessions-page.test.tsx. */}
      <CheckPanel title="Sessions" result={result}>
        {(d) => {
          // pgops's OWN connections, separated from the application's.
          //
          // Until pools.ts named them, this table interleaved ~19 idle pgops
          // backends with the three sessions in the incident, each carrying
          // its own Terminate link — a console offering to kill the console,
          // and the operator reading twenty-two rows to find three.
          //
          // Split rather than filtered, and counted rather than dropped:
          // pgops polling every 5s IS load on this database, and a tool that
          // silently removed itself from the one page that shows load would
          // be lying about the thing it exists to measure. The count is
          // always stated; only the rows are behind a link.
          const mine = d.sessions.filter((s) => s.app === APP_NAME || s.app === `${APP_NAME}-store`);
          const theirs = d.sessions.filter((s) => !(s.app === APP_NAME || s.app === `${APP_NAME}-store`));
          const shown = fold.show ? d.sessions : theirs;
          // `limit` is carried through so toggling the fold does not silently
          // reset a limit the operator set in the URL — foldFrom's rule.
          const href = fold.href;
          return (
          <>
            {stuck.locksUnavailable === null ? null : (
              <p className="mb-2 text-sm">
                <span className="font-medium">Lock graph unavailable — {stuck.locksUnavailable}. </span>
                <span className="text-muted-foreground">
                  No session below is marked as blocking or blocked, because the wait graph could
                  not be read — not because nothing is waiting.{' '}
                </span>
                <Link href={`/db/${name}/locks`} className="underline underline-offset-4">Locks</Link>
                <span className="text-muted-foreground"> has the reason.</span>
              </p>
            )}
            {d.truncated ? (
              <p className="mb-2 text-sm text-muted-foreground">
                Showing the first {d.sessions.length} — more sessions matched than are displayed.
              </p>
            ) : null}
            {shown.length === 0 ? (
              /*
                The empty state the fold made reachable, found by an
                integration test rather than by looking: on a database whose
                only client backends ARE pgops's, folding them leaves a table
                with a header, no rows, and the explanation three inches
                below it under the fold. An empty table body does not read as
                "everything here was folded"; it reads as a query that
                returned nothing or a page that failed to load — and this is
                the page an operator opens to find out whether anything is
                connected at all.
                So when there is nothing left to show, the sentence goes
                WHERE THE ROWS WOULD BE. The count is still stated and the
                rows are still one click away, which is the promise the fold
                made in the first place.
              */
              <p className="text-sm">
                {mine.length > 0 ? (
                  <>
                    <span className="font-medium">Nothing but pgops. </span>
                    <span className="text-muted-foreground">
                      No application backend is connected right now — the{' '}
                      {formatCount(mine.length)} that {mine.length === 1 ? 'is' : 'are'} open
                      {' '}belong to this console's own polling.{' '}
                    </span>
                    <Link href={href} className="underline underline-offset-4">show them</Link>
                  </>
                ) : (
                    <span className="text-muted-foreground">No client backends are connected.</span>
                  )}
                </p>
              ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    {/* `user` and `application` are two facts and were rendered
                        as one string, so a session missing both read as the
                        cryptic "—@—" and neither column could be scanned on its
                        own — on the table where "which app is doing this?" is
                        the question being asked. */}
                    <TableHead>pid</TableHead><TableHead>state</TableHead><TableHead>query age</TableHead>
                    <TableHead>txn age</TableHead>
                    <TableHead>user</TableHead><TableHead>application</TableHead>
                    <TableHead>query</TableHead>
                    {/* Pinned to the scroll container's right edge, so the one
                        control on this page is on screen at every horizontal
                        offset. The accessible name is an `sr-only` SPAN inside
                        the cell rather than `sr-only` on the cell: `sr-only`
                        sets `position: absolute`, which cannot also be sticky,
                        and an out-of-flow header cannot hold a pinned column. */}
                    {canAct ? (
                      <TableHead className="sticky right-0 bg-background">
                        <span className="sr-only">action</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((s) => (
                    <HighlightedRow key={s.pid} pid={s.pid}>
                      <TableCell>{s.pid}</TableCell>
                      <TableCell>
                        {s.state ?? '—'}
                        {stuck.blockedBy.has(s.pid) ? (
                          <span className="text-muted-foreground"> · blocked by <span className="font-mono">{stuck.blockedBy.get(s.pid)}</span></span>
                        ) : null}
                        {stuck.blocking.has(s.pid) ? (
                          <span className="font-medium"> · blocking {formatCount(stuck.blocking.get(s.pid)!)}</span>
                        ) : null}
                      </TableCell>
                      <TableCell>{formatDuration(s.queryAgeSecs)}</TableCell>
                      {/* An em dash is "not in a transaction", which is what
                          null means here; a zero would claim a transaction
                          that just started. formatDuration already returns
                          '—' for null, so that reasoning lives in the call,
                          not in a second, redundant null check beside it. */}
                      <TableCell>{formatDuration(s.xactAgeSecs)}</TableCell>
                      <TableCell>{s.user || '—'}</TableCell>
                      {/* `||`, not `??`. application_name is the EMPTY STRING
                          for a connection that never set one — not null — so
                          `??` let it through and the column rendered blank,
                          which reads as a value that failed to load rather than
                          one that was never set. The Source column beside it
                          already used `||` for exactly this. */}
                      <TableCell>{s.app || '—'}</TableCell>
                      {/* No `truncate` here, and none needed: <Sql> clamps to
                          two lines itself. The cap stays so that one long
                          statement cannot push the Terminate column off the
                          right of the table. */}
                      <TableCell className="max-w-2xl"><Sql>{s.query}</Sql></TableCell>
                      {canAct ? (
                        // `relative` is the anchor for KillButton's confirm
                        // panel, which positions itself against this cell so it
                        // opens leftward over the query column rather than
                        // widening the table off the right of the screen.
                        //
                        // `sticky right-0` keeps that cell on screen however
                        // far the table is scrolled sideways. Measured at
                        // 390x844: this column was 334px past the right edge
                        // of a 342px scroll container, so the only control on
                        // the page was reachable solely by a gesture nothing
                        // on screen asked for. The confirm panel's own anchor
                        // is unchanged and still grows leftward.
                        //
                        // `bg-inherit`, not `bg-background`: the row carries
                        // the highlight a pid link lands on and the hover
                        // tint, and an opaque cell would cut both off at this
                        // column. HighlightedRow supplies the background this
                        // inherits.
                        <TableCell className="relative sticky right-0 bg-inherit">
                          <KillButton database={name} pid={s.pid} backendStart={s.backendStart} />
                        </TableCell>
                      ) : null}
                    </HighlightedRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {shown.length > 0 && mine.length > 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {fold.show
                  ? `Including ${formatCount(mine.length)} of pgops's own connections. `
                  : `${formatCount(mine.length)} of pgops's own connections hidden. `}
                <Link href={href} className="underline underline-offset-4">
                  {fold.show ? 'hide them' : 'show them'}
                </Link>
              </p>
            ) : null}
          </>
          );
        }}
      </CheckPanel>
      <CheckPanel title="Connection sources" result={detail}>
        {(d) => (
          <>
            {d.truncated ? (
              <p className="mb-2 text-sm text-muted-foreground">
                Showing {d.connections.length} of {formatCount(d.total)} connections.
              </p>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Database</TableHead><TableHead>User</TableHead>
                  <TableHead>Source</TableHead><TableHead>IP</TableHead>
                  <TableHead className="text-right">Connections</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.sources.map((s) => (
                  // `s.key` is the same `\0`-joined, JSON.stringify'd key `map` in
                  // connections.ts already computed for the SSL-status grouping —
                  // reused rather than re-derived here so this list can't drift
                  // back to a weaker separator (see ConnectionSource's doc comment).
                  <TableRow key={s.key}>
                    <TableCell>{s.database ?? '—'}</TableCell>
                    <TableCell>{s.user ?? '—'}</TableCell>
                    <TableCell>{s.source || '—'}</TableCell>
                    {/* `client_addr` is NULL for both a unix-socket connection AND a
                        client backend this role may not read — DETAIL_SQL deliberately
                        does not filter backend_type, so a null IP here is not evidence
                        of a socket (see connections.ts's `sslStatus`, which tests
                        `Internal Process` before its own socket test for the same
                        reason). Rendering 'socket' collapsed both into a single false
                        claim on every server; the SSL breakdown below already reports
                        `Internal Process` and `Socket` as separate, correctly-derived
                        buckets, so this cell states only what it actually knows. */}
                    <TableCell>{s.ip ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatCount(s.connections)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-sm text-muted-foreground">
              {Object.entries(d.bySslStatus)
                .map(([status, n]) => `${formatCount(n)} ${status}`)
                .join(' · ')}
            </p>
          </>
        )}
      </CheckPanel>

      <CheckPanel title="Active now" result={active}>
        {(d) => <ActiveNow name={name} data={d} />}
      </CheckPanel>
      <CheckPanel title="Long-running queries" result={stuck.longRunning}>
        {(d) => <LongRunning name={name} queries={d.queries} canAct={canAct} stuck={stuck} />}
      </CheckPanel>

      <RecentActions records={recent.records} unreadable={recent.unreadable} />
    </>
  );
}

/**
 * Task 1: what the server is doing right now, above the long-running list —
 * the first question a DBA asks during an incident, and the one this
 * console could not answer before this check existed.
 *
 * Wait rows read as "12 IO · DataFileRead" and "30 running", which is the
 * sentence a DBA says out loud. The waits list is sorted by the SQL, biggest
 * bucket first. Both truncation notes say "the busiest 30", which is what the
 * `row_number()` cap actually selects — not "some were hidden".
 */
function ActiveNow({ name, data: d }: { name: string; data: ActivityData }) {
  // MEASURED (activity.ts's ActivityRow.sees_all docblock): a role without
  // pg_read_all_stats gets NULL `state` for every backend it does not own,
  // and this check's SQL filters on `state = 'active'` — so the zero this
  // panel would otherwise report is "we could not fully look", not "nothing
  // is running", and the empty state below must never claim the latter. The
  // caveat renders ABOVE the panel body rather than replacing it, because a
  // restricted role's own sessions are still real rows worth showing.
  // `grantRemedy` (packages/checks/src/run.ts), not a literal statement typed
  // here: apps/web's guards.test.ts DDL boundary allows a hardcoded GRANT
  // string in exactly two files in the whole repo, run.ts among them, and
  // this stays a second caller of that one string rather than a second copy
  // of it.
  const caveat = d.restricted ? (
    <p className="mb-3 text-sm">
      <span className="font-medium">This role can&apos;t see other sessions&apos; state. </span>
      <span className="text-muted-foreground">
        {'Every count below covers only sessions this role owns, not the whole server '
          + '— a saturated database can read exactly like an idle one from here. Fix: '
          + `${grantRemedy('pg_read_all_stats')}`}
      </span>
    </p>
  ) : null;
  if (d.active === 0) {
    return (
      <>
        {caveat}
        {d.restricted ? null : (
          <p className="text-sm text-muted-foreground">Nothing is executing right now.</p>
        )}
      </>
    );
  }
  return (
    <>
      {caveat}
      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_2fr]">
      <div>
        <p className="mb-2 text-sm"><span className="font-medium">{formatCount(d.active)} active</span></p>
        <ul className="grid gap-1 text-sm">
          {d.waits.map((w) => (
            <li key={`${w.type}-${w.event ?? ''}`} className="flex justify-between gap-3">
              <span>{formatCount(w.sessions)} {w.type}{w.event ? ` · ${w.event}` : ''}</span>
              <span className="text-muted-foreground tabular-nums">longest {formatDuration(w.longestSecs)}</span>
            </li>
          ))}
        </ul>
        {d.waitsTruncated ? (
          <p className="mt-2 text-xs text-muted-foreground">Showing the busiest 30 wait buckets.</p>
        ) : null}
      </div>
      <div>
        <ul className="grid gap-2 text-sm">
          {d.shapes.map((s) => {
            const statement = s.statement;
            return (
              // NEVER the statement text (or a value derived from it) as a
              // React key. Under RSC, a key is serialized into the Flight
              // payload embedded in the document — unlike a normal prop, it
              // is not merely "not rendered as an attribute", it ships in
              // the HTML regardless. `<Sql>` below redacts the VISIBLE text
              // correctly; the leak this caused (routes.int.test.ts, the
              // four-version gate) was purely the key, holding a raw
              // `pg_stat_activity.query` with a live password in it.
              // `shapeKey` (packages/checks/src/checks/activity.ts) is the
              // safe substitute: the server's own query_id, or an md5 of the
              // text — a stable identity for the shape, never a secret.
              <li key={s.shapeKey}>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium tabular-nums">{formatCount(s.sessions)} ×</span>
                  <span className="text-muted-foreground">longest {formatDuration(s.longestSecs)}</span>
                  {s.queryId === null ? null : (
                    <Link href={`/db/${name}/queries/${s.queryId}`} className="text-xs underline underline-offset-2">history</Link>
                  )}
                </p>
                <Sql>{statement}</Sql>
              </li>
            );
          })}
        </ul>
        {d.shapesTruncated ? (
          <p className="mt-2 text-xs text-muted-foreground">Showing the busiest 30 statement shapes.</p>
        ) : null}
      </div>
      </div>
    </>
  );
}

/**
 * Task 5 (review finding 4): after a kill the row vanishes and with it the
 * only feedback the operator gets. The audit log already records every
 * action; this panel is what reads it back.
 *
 * Renders nothing ONLY when there is no history AND nothing went wrong —
 * same rule as every other empty panel on this page (ActiveNow, LongRunning):
 * a section with a heading and no rows reads as a failed load, not as
 * "nothing happened yet". But that rule cuts the other way too, which is the
 * fix this function exists for: when `unreadable` is set, rendering NOTHING
 * is exactly the failed-load reading, and it is indistinguishable from "no
 * action has ever been taken against this database" — on the one panel that
 * is this console's whole record of who terminated what. So an unreadable
 * log still renders the section, with a caveat in the same voice as
 * `stuck.locksUnavailable`'s two callers above (Sessions' own "Lock graph
 * unavailable" and LongRunning's "Cannot tell which of these are waiting"):
 * name what is unavailable, then say what the reader must not conclude from
 * its absence — here, that the list below being empty or short does NOT
 * mean nothing was done, only that this console could not check.
 */
function RecentActions({
  records,
  unreadable,
}: {
  records: readonly AuditRecord[];
  unreadable: string | null;
}) {
  if (records.length === 0 && unreadable === null) return null;
  return (
    <section className="py-1">
      <header className="mb-3 border-b pb-2">
        <h2 className="font-semibold">Recent actions</h2>
        <p className="text-xs text-muted-foreground">
          From this console instance&apos;s audit log. Other instances keep their own.
        </p>
      </header>
      {unreadable === null ? null : (
        <p className="mb-2 text-sm">
          <span className="font-medium">Audit log unavailable — {unreadable}. </span>
          <span className="text-muted-foreground">
            The record of actions taken against this database could not be read, so the
            list below — empty or not — is not evidence that nothing was done; it is only
            what this console could check.
          </span>
        </p>
      )}
      <ul className="text-sm">
        {records.map((r) => (
          <li key={`${r.timestamp}-${String(r.target.pid ?? '')}`} className="flex flex-wrap gap-x-2 py-0.5">
            <span className="text-muted-foreground">{formatAgo(r.timestamp) ?? r.timestamp}</span>
            <span className="font-medium">{r.action}</span>
            {r.target.pid === undefined ? null : <span className="font-mono">{String(r.target.pid)}</span>}
            <span>{r.result}</span>
            {r.reason ? <span className="text-muted-foreground">— {r.reason}</span> : null}
            <span className="text-muted-foreground">by {r.user}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * #12's surface: the diagnosis, then the action over exactly what it names.
 *
 * The list comes FIRST and renders whether or not actions are enabled. That
 * ordering is the capability: pgHero's kill_long_running_queries is a sweep,
 * and #13 kill_all is declined here permanently as "an action with no
 * diagnosis". What makes this one legitimate is that an operator sees the
 * sessions before deciding, so a control without the list would be the
 * declined capability shipped under the allowed one's name.
 *
 * Each target carries its OWN `backendStart`, captured in this render. That is
 * the PID-reuse guard: killBackend compares it inside the same statement as
 * the terminate, so a pid recycled between this render and the operator's
 * confirmation is refused rather than killed. Re-deriving it server-side would
 * compare the server's current idea of the session against itself.
 *
 * Nothing renders when actions are off — not a disabled button, which
 * advertises a capability that is switched off, the same disclosure the
 * route's 404 exists to prevent.
 */
function LongRunning({
  name,
  queries,
  canAct,
  stuck,
}: {
  name: string;
  queries: readonly { pid: number; runningSecs: number; query: string | null; backendStart: string | null }[];
  canAct: boolean;
  stuck: Stuck;
}) {
  if (queries.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing running past {LONG_RUNNING_FLOOR_SECS}s.</p>;
  }
  return (
    <>
      <ul className="text-sm">
        {queries.map((q) => (
          <li key={q.pid} className="flex justify-between gap-4 py-0.5">
            <span className="font-medium">
              {q.pid}
              {stuck.blockedBy.has(q.pid) ? (
                <span className="ml-2 font-normal text-muted-foreground">blocked by <span className="font-mono">{stuck.blockedBy.get(q.pid)}</span></span>
              ) : null}
              {/* Through <Sql>, like every other rendered statement in this
                  console: it redacts, and guards.test.ts fails for any query
                  field interpolated directly. It renders an em dash for null,
                  which is what a statement this role may not read looks
                  like. */}
              <span className="ml-2 font-normal text-muted-foreground">
                <Sql>{q.query}</Sql>
              </span>
            </span>
            <span className="text-muted-foreground">{formatDuration(q.runningSecs)}</span>
          </li>
        ))}
      </ul>
      {/* Above Terminate all, not beside it and not one panel below: Task 15
          put this sentence in the Sessions panel, and the operator reading
          top to bottom met the bulk-kill control before the warning about
          it. This panel is the one that acts, so the caveat has to sit
          where the action is. */}
      {stuck.locksUnavailable === null ? null : (
        <p className="mt-3 max-w-prose text-sm">
          <span className="font-medium">Cannot tell which of these are waiting — {stuck.locksUnavailable}. </span>
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
      {stuck.allStuck ? (
        <p className="mt-3 max-w-prose text-sm">
          <span className="font-medium">Not slow — waiting. </span>
          <span className="text-muted-foreground">
            Every query here is queued behind a lock chain, so these durations are time
            spent waiting rather than working. Terminating one frees nothing; the session
            to act on is the root blocker, marked "blocking" in the table below.
          </span>
        </p>
      ) : canAct ? (
        <div className="mt-3">
          <ConfirmAction
            label="Terminate all"
            endpoint={`/api/db/${encodeURIComponent(name)}/kill-long-running`}
            confirmWith={name}
            danger={`Terminates ${queries.length} ${queries.length === 1 ? 'session' : 'sessions'}. Each is checked against the identity captured above, so one that has since been replaced is refused rather than killed.`}
            body={{ targets: queries.map((q) => ({ pid: q.pid, backendStart: q.backendStart })) }}
            describe="kill-batch"
          />
        </div>
      ) : null}
    </>
  );
}
