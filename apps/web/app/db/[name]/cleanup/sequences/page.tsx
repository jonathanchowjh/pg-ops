import type { Metadata } from 'next';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { cacheChecks } from '@/lib/hygiene';
import { CheckPanel } from '@/components/check-panel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FoldNote } from '@/components/fold-note';
import { foldFrom, foldOurs } from '@/lib/fold';
import { formatCount, plural } from '@/lib/format';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Sequences` };
}

/**
 * #52, #53, #54 — one check, three pgHero capabilities. No `<Refresh>`.
 *
 * The percentage is never rendered alone. A sequence at 2,000,000,000 is 93%
 * of an `integer` column and 0.00000002% of a `bigint` one, and only the
 * first is a problem — so the ceiling it is a percentage OF travels with it.
 * `maxValue` itself is deliberately NOT rendered: the bigint maximum is not
 * exactly representable as a JS number and arrives as 9223372036854776000,
 * which is the wrong number to show an operator. The type name is not.
 */
export default async function Sequences({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ pgops?: string }>;
}) {
  const { name } = await params;
  // pgops's own sequences — its store's tables have them — folded out of the
  // list below. See lib/fold.ts.
  const fold = foldFrom(`/db/${name}/cleanup/sequences`, await searchParams);
  const result = await runCheckFor(name, CHECKS.sequences, {});

  // The same readings, written where the triage page can see them. The page
  // is unchanged — it ran these checks just now, on visit — and this is what
  // stops the triage line reporting a finding this page has already
  // disproved. Never throws, and does nothing at all without a store.
  await cacheChecks(name, { sequences: result });

  return (
    <div className="grid gap-4">
      <CheckPanel title="Sequences, against the column they feed" result={result} count={(d) => d.total}>
        {(d) => {
          const { shown, mine } = foldOurs(d.sequences, (s) => s.name, fold.show);
          return (
          <>
            {d.sequences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sequences in a visible schema.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>sequence</TableHead>
                    <TableHead>feeds</TableHead>
                    <TableHead>column type</TableHead>
                    <TableHead className="text-right">used</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((s) => (
                    <TableRow key={s.name}>
                      <TableCell className="font-mono font-medium">{s.name}</TableCell>
                      <TableCell className="font-mono">
                        {s.table === null
                          ? <span className="font-sans text-muted-foreground">nothing</span>
                          : `${s.table}.${s.column}`}
                      </TableCell>
                      {/* The ceiling the percentage is OF, in its own column.
                          A sequence at 2,000,000,000 is 93% of an `integer`
                          and 0.00000002% of a `bigint`, and only the first is
                          a problem — so the two are never separated. */}
                      <TableCell className="text-muted-foreground">
                        {s.columnType ?? '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/*
                          Three states, kept distinct because they are three
                          different facts. `pctUsed: null` covers two of them —
                          a sequence nothing has called yet, and one this role
                          cannot read — and collapsing either to `0%` would
                          claim a reading we do not have.
                        */}
                        {s.pctUsed === null
                          ? (
                            <span className="text-muted-foreground">
                              {s.readable ? 'never used' : 'not readable'}
                            </span>
                          )
                          : `${s.pctUsed.toFixed(1)}%`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {d.truncated ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Showing {formatCount(d.sequences.length)} of {formatCount(d.total)},
                closest to its ceiling first.
              </p>
            ) : null}

            {/*
              #54, and a database-wide count rather than a count of this page
              — so a role that can read none of them still learns how many it
              is not seeing.

              The wording avoids the word "grant" followed by a privilege
              name, and that is not squeamishness: guards.test.ts's DDL
              boundary matches /GRANT\s+[A-Z]{2,}/i case-insensitively and
              now scans apps/web too (its I7 note extended it there, because
              apps/web holds the pools to the monitored databases). "Grant
              select or usage on them" is prose, but the guard cannot tell a
              sentence from a statement — the same trap constraints.ts's
              remedy text hit with "alter table … validate constraint". The
              advice is unchanged; only the grammar is.
            */}
            {d.unreadable > 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {plural(d.unreadable, 'sequence')} could not be read by this role and are
                excluded from every number above. A role holding select or usage on them would
                see them here.
              </p>
            ) : null}

            <FoldNote mine={mine} fold={fold} />
          </>
          );
        }}
      </CheckPanel>
    </div>
  );
}
