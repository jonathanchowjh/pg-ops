import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { Sql } from '@/components/sql';
import { formatCount, formatDuration } from '@/lib/format';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SORTS = ['total', 'mean', 'calls'] as const;
type Sort = (typeof SORTS)[number];

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
  const chosen: Sort = SORTS.includes(sort as Sort) ? (sort as Sort) : 'total';
  const result = await runCheckFor(name, CHECKS.queryStats, { sort: chosen });

  return (
    <CheckPanel title="Query statistics" result={result}>
      {(d) => (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {formatCount(d.totalShapes)} statement shape(s)
            {d.statsResetAt ? ` · stats reset ${d.statsResetAt}` : ''}
            {/* There is no `truncated` flag on QueryStatsData: totalShapes is
                every shape visible to this role BEFORE the LIMIT, so a short
                rows array against a larger totalShapes IS the truncation. */}
            {d.rows.length < d.totalShapes ? ` · showing ${d.rows.length}` : ''}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>calls</TableHead><TableHead>total</TableHead>
                <TableHead>mean</TableHead><TableHead>query</TableHead>
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
                <TableRow key={`${q.queryid ?? 'null'}-${i}`}>
                  <TableCell>{formatCount(q.calls)}</TableCell>
                  {/* totalMs/meanMs are MILLISECONDS, not seconds — formatDuration
                      takes seconds, so dividing by 1000 is load-bearing: without it
                      a 250ms query renders as "250h 0m". */}
                  <TableCell>{formatDuration(q.totalMs / 1000)}</TableCell>
                  <TableCell>{formatDuration(q.meanMs / 1000)}</TableCell>
                  <TableCell className="max-w-xl">
                    {/* `redacted` means Postgres withheld the text from this
                        role — the ROW still counts, so say so rather than
                        rendering an empty cell that reads as "no query". */}
                    {q.redacted ? <span className="text-xs italic">insufficient privilege</span> : <Sql>{q.query}</Sql>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </CheckPanel>
  );
}
