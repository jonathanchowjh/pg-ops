import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { APP_NAME } from '@/lib/config';
import { actionsAllowed } from '@/lib/actions';
import { CheckPanel } from '@/components/check-panel';
import { KillButton } from '@/components/kill-button';
import { Refresh } from '@/components/refresh';
import { Sql } from '@/components/sql';
import { formatCount, formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
  const showPgops = pgops === 'show';
  const parsed = Number(limit);
  // Promise.all, not two sequential awaits: this is the one page whose
  // entire subject is the live connection picture, and two serialized round
  // trips are two snapshots of pg_stat_activity taken at different instants
  // — on a page that already re-fetches every 5 seconds. Every other
  // multi-check page (app/page.tsx, app/db/[name]/page.tsx) does the same.
  const [result, detail] = await Promise.all([
    runCheckFor(name, CHECKS.sessions, {
      limit: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    }),
    runCheckFor(name, CHECKS.connectionDetail, {}),
  ]);
  // Read here, after runCheckFor has already awaited connection() — so this
  // page is dynamic before the gate is read, and the gate reflects the
  // deployment rather than being frozen at build time. Not hoisted to module
  // scope; see lib/check.ts and test/guards.test.ts.
  const canAct = actionsAllowed(process.env);

  return (
    <>
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="mb-2 flex justify-end"><Refresh intervalMs={5_000} /></div>
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
          const shown = showPgops ? d.sessions : theirs;
          // `limit` is carried through so toggling the fold does not silently
          // reset a limit the operator set in the URL.
          const href = { pathname: `/db/${name}/sessions`, query: {
            ...(limit ? { limit } : {}), ...(showPgops ? {} : { pgops: 'show' }) } };
          return (
          <>
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
                    <TableHead>pid</TableHead><TableHead>state</TableHead><TableHead>age</TableHead>
                    <TableHead>user</TableHead><TableHead>application</TableHead>
                    <TableHead>query</TableHead>{canAct ? <TableHead className="sr-only">action</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((s) => (
                    <TableRow key={s.pid}>
                      <TableCell>{s.pid}</TableCell>
                      <TableCell>{s.state ?? '—'}</TableCell>
                      <TableCell>{formatDuration(s.queryAgeSecs)}</TableCell>
                      <TableCell>{s.user || '—'}</TableCell>
                      {/* `||`, not `??`. application_name is the EMPTY STRING
                          for a connection that never set one — not null — so
                          `??` let it through and the column rendered blank,
                          which reads as a value that failed to load rather than
                          one that was never set. The Source column beside it
                          already used `||` for exactly this. */}
                      <TableCell>{s.app || '—'}</TableCell>
                      {/* No `truncate` here. It sets overflow-hidden + ellipsis
                          on the cell while <Sql> sets overflow-x-auto on the
                          <code> inside it — two competing overflow contexts, so
                          the query scrolled inside a box that also clipped it
                          and the ellipsis never appeared. The cap stays; the
                          child does the scrolling, which is the one of the two
                          behaviours that can still reveal the whole query. */}
                      {/* Widened with the shell. The cap is what forced each
                          query into its OWN horizontal scrollbar — a table of
                          twenty independently-scrolling cells, when the table
                          itself already scrolls as one piece (ui/table.tsx sets
                          overflow-x-auto). It stays capped so one long statement
                          cannot push the action column off the right. */}
                      <TableCell className="max-w-2xl"><Sql>{s.query}</Sql></TableCell>
                      {canAct ? (
                        // `relative` is the anchor for KillButton's confirm
                        // panel, which positions itself against this cell so it
                        // opens leftward over the query column rather than
                        // widening the table off the right of the screen.
                        <TableCell className="relative">
                          <KillButton database={name} pid={s.pid} backendStart={s.backendStart} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {shown.length > 0 && mine.length > 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {showPgops
                  ? `Including ${formatCount(mine.length)} of pgops's own connections. `
                  : `${formatCount(mine.length)} of pgops's own connections hidden. `}
                <Link href={href} className="underline underline-offset-4">
                  {showPgops ? 'hide them' : 'show them'}
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
    </>
  );
}
