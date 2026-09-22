import type { Metadata } from 'next';
import { CHECKS } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { formatCount } from '@/lib/format';

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
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const result = await runCheckFor(name, CHECKS.sequences, {});

  return (
    <div className="grid gap-4">
      <CheckPanel title="Sequences, against the column they feed" result={result}>
        {(d) => (
          <>
            {d.sequences.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sequences in a visible schema.</p>
            ) : (
              <ul className="text-sm">
                {d.sequences.map((s) => (
                  <li key={s.name} className="flex justify-between gap-4 py-0.5">
                    <span className="font-medium">
                      {s.name}
                      {s.table === null ? null : (
                        <span className="text-muted-foreground"> · {s.table}.{s.column}</span>
                      )}
                    </span>
                    <span className="text-muted-foreground">
                      {/*
                        Three states, kept distinct because they are three
                        different facts. `pctUsed: null` covers two of them —
                        a sequence nothing has called yet, and one this role
                        cannot read — and collapsing either to `0%` would
                        claim a reading we do not have.
                      */}
                      {s.pctUsed === null
                        ? (s.readable ? 'never used' : 'not readable by this role')
                        : <>{s.pctUsed.toFixed(1)}% of {s.columnType ?? 'its column type'}</>}
                    </span>
                  </li>
                ))}
              </ul>
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
                {formatCount(d.unreadable)} sequence(s) could not be read by this role and are
                excluded from every number above. A role holding select or usage on them would
                see them here.
              </p>
            ) : null}
          </>
        )}
      </CheckPanel>
    </div>
  );
}
