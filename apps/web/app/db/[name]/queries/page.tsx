import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, SERIES, slowQueries, SLOW_QUERY_DEFAULTS } from '@pgops/checks';
import { runCheckFor, runSeriesFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Badge } from '@/components/ui/badge';
import { Refresh } from '@/components/refresh';
import { SubNav } from '@/components/sub-nav';
import { Sql } from '@/components/sql';
import { formatCount, formatMillis } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

const SORTS = ['total', 'mean', 'calls'] as const;
type Sort = (typeof SORTS)[number];

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Queries` };
}

/**
 * The control this page advertised and did not have.
 *
 * `?sort=` has always been read here, and the README has always described
 * this route as "sortable by total, mean or calls" — but nothing on the page
 * could set it. The ordering was reachable only by hand-editing the URL, and
 * an operator who arrived on a non-default one had no way to tell which
 * ordering produced the rows they were looking at, let alone change it.
 *
 * A link, not a button: the sort is already URL state, so it is already
 * shareable, bookmarkable and back-button-able. Making it a control that
 * mutates client state would take those three properties away to add
 * nothing. Always descending — every sort here means "worst first", and an
 * ascending pg_stat_statements ranking answers no question anyone has during
 * an incident.
 */
function SortableHead({
  name,
  sort,
  chosen,
  children,
}: {
  name: string;
  sort: Sort;
  chosen: Sort;
  children: ReactNode;
}) {
  const active = sort === chosen;
  return (
    <TableHead aria-sort={active ? 'descending' : 'none'}>
      <Link
        href={`/db/${name}/queries?sort=${sort}`}
        className={cn(
          'underline-offset-4 hover:underline',
          active ? 'font-semibold text-foreground' : 'text-muted-foreground',
        )}
      >
        {children}
        {/* A caret, not colour alone, marks the active column. */}
        {active ? ' \u2193' : ''}
      </Link>
    </TableHead>
  );
}

/**
 * Ruling 55: `queryStats` is scoped to the CURRENT database by dbid, which is
 * what makes this route coherent — pg_stat_statements is cluster-wide, and an
 * unlabelled cross-database ranking on a per-database page would attribute one
 * database's load to another.
 */
export default async function Queries({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ sort?: string }>;
}) {
  const { name } = await params;
  const { sort } = await searchParams;
  // Default 'total', as this page shipped in an earlier phase — "worst
  // queries by total time". A 'mean' default was tried in this branch and
  // reverted: slowQueries is a CONJUNCTION over two axes (calls >= 100 AND
  // meanMs >= 20), and no single-axis top-N window can complete a two-axis
  // conjunctive filter. Sorting by mean orders by one input and is blind to
  // the other, so the window fills with one-off expensive statements
  // (migrations, ANALYZE, ad-hoc reports) that fail calls >= 100, while a
  // 25ms shape called a million times — the archetypal slow-query finding —
  // can sit outside the window entirely unexamined. `total = calls * mean`
  // is monotone in BOTH inputs, so every qualifying row necessarily has
  // total >= 2000ms and a total-sorted window can't exclude it the same way.
  // The "Slow queries" panel's truncation caveat below is sort-agnostic
  // (c87b47b) precisely because the panel never checks which sort produced
  // its rows, so that property holds identically under 'total'.
  const chosen: Sort = SORTS.includes(sort as Sort) ? (sort as Sort) : 'total';
  const result = await runCheckFor(name, CHECKS.queryStats, { sort: chosen });
  // Spec §5.1: P3's only visible deliverable. One indexed lookup per render,
  // and it must stay that way — this is an INCIDENT page and it polls at 5s.
  const since = await lastIntervalByQueryid(name, result.ok ? result.data.rows : []);

  return (
    <>
      {/* Task 1: the poll lives on the incident pages, not the layout —
          hygiene routes share that layout and must not inherit a 5s
          catalog scan. test/guards.test.ts holds this. */}
      <div className="mb-2 flex justify-end"><Refresh intervalMs={5_000} /></div>
      <SubNav
        name={name}
        base="queries"
        items={[{ segment: 'indexes', label: 'Indexes' }, { segment: 'tables', label: 'Tables' }]}
      />
      {/*
       * pgHero #17 slow_queries: NOT a query, a FILTER over #14's rows
       * (query_stats.select { calls >= slow_query_calls && average_time >=
       * slow_query_ms }). Reuses `result` — the same fetch the table below
       * renders — rather than issuing a second pg_stat_statements scan for
       * rows this page already has (see query-stats.ts's `slowQueries` doc
       * comment).
       */}
      <CheckPanel title="Slow queries" result={result}>
        {(d) => {
          const slow = slowQueries(d);
          // Same truncation `d.rows.length` vs `d.totalShapes` carries below
          // in "Query statistics" — but there it only clips what's DISPLAYED.
          // Here it clips what was ever CHECKED: slowQueries only sees
          // `d.rows`, so a shape outside that LIMIT window was never
          // evaluated against either bound — not "evaluated and found not
          // slow", just never looked at. That holds no matter which sort
          // produced the fetch: `chosen` (below `?sort=`) can be 'total',
          // 'mean' or 'calls', and this panel never checks which one it got —
          // and no sort would let it skip this caveat anyway. slowQueries is
          // a CONJUNCTION over two axes (calls and mean), and no single-axis
          // top-N window can complete a two-axis conjunctive filter (see
          // query-stats.ts's `slowQueries` doc comment): every sort leaves
          // some qualifying shape outside the window it could miss. An
          // unqualified "no slow queries" would be a claim about the
          // database this panel cannot actually back, so scope every
          // sentence to what was fetched whenever fetched < total, exactly
          // as the neighboring panel already does.
          const truncated = d.rows.length < d.totalShapes;
          // Built as one plain string, not nested JSX conditionals — a
          // newline between two `{}` expression children with no literal
          // text between them collapses to NOTHING in JSX (not a space), so
          // interleaving conditionals across lines here risks a silent
          // "…100shown…" concatenation. A single template literal has no
          // such hazard.
          const bound = `${SLOW_QUERY_DEFAULTS.minMeanMs}ms or more over ${SLOW_QUERY_DEFAULTS.minCalls}+ calls`;
          const scope = truncated
            ? `the ${formatCount(d.rows.length)} shown (of ${formatCount(d.totalShapes)} total)`
            : null;
          const sentence =
            slow.length === 0
              ? scope
                ? `No shape among ${scope} averages ${bound}. A shape outside that set was not examined.`
                : `No shape averages ${bound}.`
              : scope
                ? `${formatCount(slow.length)} of ${scope} shapes average ${bound}.`
                : `${formatCount(slow.length)} of ${formatCount(d.rows.length)} shapes average ${bound}.`;
          return (
            <p className={slow.length === 0 ? 'text-sm text-muted-foreground' : 'text-sm'}>{sentence}</p>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Query statistics" result={result}>
        {(d) => {
          // WHICH shapes the panel above is counting.
          //
          // That panel says "1 of 53 shapes average 20ms or more over 100+
          // calls" and this table then listed all 53 with nothing to say
          // which one it meant — the operator was told a number and left to
          // re-derive the filter by eye, across two columns, on an incident
          // page. The sentence and the row are the same fact and were three
          // inches apart with no thread between them.
          //
          // A Set of the row OBJECTS, not of queryids. `slowQueries` filters
          // `d.rows`, so the qualifying rows are the very same references and
          // membership is exact. Matching on queryid would be wrong here for
          // a reason this file already documents two comments below:
          // pg_stat_statements is keyed by (userid, dbid, queryid, toplevel)
          // and this check does not aggregate over userid, so one queryid can
          // legitimately name two rows — and only one of them may qualify.
          const slow = new Set(slowQueries(d));
          return (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              {formatCount(d.totalShapes)} statement shape(s)
              {/* `?sort=` is reachable with no control on the page for it, so an
                  operator who lands on a non-default URL has no other way to
                  tell which ordering produced these rows — except on an EMPTY
                  list, where there is nothing that was ordered: `map` in
                  query-stats.ts falls back to `sort: 'total'` when there are
                  zero rows (there is no `requested_sort` to read back), and
                  that fallback is a real value on `d.sort` whether or not the
                  caller actually asked for 'total'. Suppressing the label here
                  keeps that fallback unobserved, rather than asserting an
                  ordering that never happened. */}
              {d.rows.length > 0 ? ` · sorted by ${d.sort}` : ''}
              {d.statsResetAt ? ` · stats reset ${d.statsResetAt}` : ''}
              {/* There is no `truncated` flag on QueryStatsData: totalShapes is
                  every shape visible to this role BEFORE the LIMIT, so a short
                  rows array against a larger totalShapes IS the truncation. */}
              {d.rows.length < d.totalShapes ? ` · showing ${d.rows.length}` : ''}
            </p>
            {since.kind === 'unavailable' && (
              /* Said out loud, not shown as an absent column. A store that is
                 configured and failing is a different fact from no store, and
                 the operator is the only one who can act on it. */
              <p className="mb-2 text-sm">
                History is configured but could not be read, so no
                since-last-capture figures are shown: {since.message}
              </p>
            )}
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead name={name} sort="calls" chosen={chosen}>calls</SortableHead>
                  <SortableHead name={name} sort="total" chosen={chosen}>total</SortableHead>
                  <SortableHead name={name} sort="mean" chosen={chosen}>mean</SortableHead>
                  {since.kind === 'ok' && <TableHead>Since last capture</TableHead>}
                  <TableHead>query</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* I3: keyed by `queryid` alone, this produced DUPLICATE keys on
                    a real database. pg_stat_statements is keyed by (userid, dbid,
                    queryid, toplevel); the check filters dbid and toplevel but not
                    userid, and does not aggregate — so two roles running the same
                    normalized statement return two rows carrying the same queryid
                    (reproduced on PG 17: `postgres` and a `reporting` role running
                    the same statement, 3 rows, 1 duplicated queryid). Both rows
                    mount, but this page re-renders every 5s via router.refresh(),
                    and React calls reconciliation across updates with duplicate
                    keys unsupported — on the page that ranks queries by cost,
                    calls/total/mean can attach to the wrong row. The index alone
                    would be stable enough; queryid is kept in front of it so the
                    key still changes when the ranking genuinely changes. */}
                {d.rows.map((q, i) => (
                  <TableRow key={`${q.queryid ?? 'null'}-${i}`} className={slow.has(q) ? 'bg-warning/5' : undefined}>
                    <TableCell>{formatCount(q.calls)}</TableCell>
                    {/* totalMs/meanMs are MILLISECONDS. These went through
                        formatDuration(ms / 1000), which floors to whole
                        seconds — so every mean under a second rendered "0s",
                        on the column this page ranks by. formatMillis keeps
                        the unit the data is actually in. */}
                    <TableCell>{formatMillis(q.totalMs)}</TableCell>
                    <TableCell>{formatMillis(q.meanMs)}</TableCell>
                    {since.kind === 'ok' && (
                      <TableCell>
                        {/* An em dash, not a blank: this shape has no interval
                            between the last two captures — it was not seen, or
                            the interval spanned a discontinuity and was
                            dropped. Blank would read as zero. */}
                        {since.byQueryid.has(q.queryid ?? '')
                          ? (() => {
                              const n = since.byQueryid.get(q.queryid ?? '')!.calls;
                              return `${formatCount(n)} ${n === 1 ? 'call' : 'calls'}`;
                            })()
                          : '—'}
                      </TableCell>
                    )}
                    <TableCell className="max-w-3xl">
                      {/* `redacted` means Postgres withheld the text from this
                          role — the ROW still counts, so say so rather than
                          rendering an empty cell that reads as "no query". */}
                      {slow.has(q) ? (
                        <Badge variant="warning" className="mr-2 align-middle">SLOW</Badge>
                      ) : null}
                      {q.redacted ? <span className="text-xs italic">insufficient privilege</span> : <Sql>{q.query}</Sql>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
          );
        }}
      </CheckPanel>
    </>
  );
}

/**
 * Delta for each shape between the two most recent captures.
 *
 * Three outcomes, not two. I9 (final review): this returned `null` for both
 * "no store configured" and "the store is broken", so a deployment whose
 * store had filled its disk rendered BYTE-IDENTICALLY to one with no store at
 * all — while the scheduler failed every five minutes into a stderr stream
 * nobody is watching. `runSeriesFor` distinguishes `missing-store` from every
 * other reason precisely so this does not have to blur it.
 *
 * I2 (final review): bounded to the two most recent captures and to the
 * shapes this page actually renders. Spec §5.1 requires one indexed lookup
 * per render on a page that polls at 5s; unbounded, this read every snapshot
 * in a twenty-minute window with its full query text attached.
 */
type Since =
  | { kind: 'absent' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'ok'; byQueryid: Map<string, { calls: number; totalExecTime: number }> };

async function lastIntervalByQueryid(
  name: string,
  rows: readonly { queryid: string | null }[],
): Promise<Since> {
  const queryids = rows.map((r) => r.queryid).filter((q): q is string => q !== null);
  const result = await runSeriesFor(
    name, SERIES.historicalQueryStats,
    // Two captures at a five-minute cadence sit inside twenty minutes with
    // room for one missed tick; `maxSnapshots` is what actually bounds the
    // read, and the window is the outer guard.
    { from: new Date(Date.now() - 20 * 60_000), to: new Date() },
    { databaseName: name, maxSnapshots: 2, queryids },
  );
  if (!result.ok) {
    return result.reason === 'missing-store'
      ? { kind: 'absent' }
      : { kind: 'unavailable', message: result.message };
  }
  const byQueryid = new Map<string, { calls: number; totalExecTime: number }>();
  for (const shape of result.points) {
    const last = shape.intervals.at(-1);
    if (last) byQueryid.set(shape.queryid, { calls: last.calls, totalExecTime: last.totalExecTime });
  }
  return { kind: 'ok', byQueryid };
}
