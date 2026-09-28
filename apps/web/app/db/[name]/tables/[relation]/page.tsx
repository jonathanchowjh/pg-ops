import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CHECKS, SERIES,
  type CheckResult, type DuplicateData, type IndexFindingData,
} from '@pgops/checks';
import { runCheckFor, runSeriesFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { LineChart } from '@/components/line-chart';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo, formatBytes, formatCount } from '@/lib/format';

const DAYS = 30;
const MAX_POINTS = 500;

export async function generateMetadata(
  { params }: { params: Promise<{ name: string; relation: string }> },
): Promise<Metadata> {
  const { name, relation } = await params;
  return { title: `${name} · ${relation}` };
}

/**
 * ONE TABLE, and everything pgops knows about it (design §5.3).
 *
 * Eight pages render a relation name and none of them was about that
 * relation; this is the page that is. Every panel below comes from a check
 * ASKED about this one relation rather than from filtering a capped list —
 * see §5.2, and `RelationOpts` in packages/checks/src/checks/indexes.ts. A
 * table outside every cap would otherwise render every fact as an em dash,
 * which is this console's display for "we could not look" and would be
 * showing it for "we did not ask".
 *
 * `relation` arrives ALREADY DECODED from Next — `EntityLink` encoded it, and
 * decoding again would corrupt a name containing a literal percent.
 *
 * No `<Refresh>`: nothing here moves in five seconds, and guards.test.ts
 * holds that from the source side.
 */
export default async function TablePage({ params }: {
  params: Promise<{ name: string; relation: string }>;
}) {
  const { name, relation } = await params;
  const opts = { relation };

  const [table, xid, indexes, unused, duplicates, invalid, seqs, history] = await Promise.all([
    runCheckFor(name, CHECKS.tableList, opts),
    runCheckFor(name, CHECKS.autovacuumDanger, opts),
    runCheckFor(name, CHECKS.indexList, opts),
    runCheckFor(name, CHECKS.unusedIndexes, opts),
    runCheckFor(name, CHECKS.duplicateIndexes, opts),
    runCheckFor(name, CHECKS.invalidIndexes, opts),
    runCheckFor(name, CHECKS.sequences, opts),
    runSeriesFor(name, SERIES.relationSpace,
      { from: new Date(Date.now() - DAYS * 24 * 3_600_000), to: new Date() },
      { databaseName: name, relation, maxPoints: MAX_POINTS }),
  ]);

  // NOT `cacheChecks`. Every other hygiene page writes its result under the
  // check's id so the triage page can read the same reading — but those
  // pages run their checks unfiltered, with `{}`. This page runs six
  // relation-scoped queries; caching those under `indexList` or `sequences`
  // would hand the triage page one table's readings as the whole database's
  // state. Task 4's tables list carries the same comment for the same
  // reason.

  // A 404 only when the check SUCCEEDED and found nothing. `ok: false` is
  // "we could not look", and answering that with "no such table" would send
  // an operator to correct a name that was right.
  if (table.ok && table.data.tables.length === 0) notFound();

  // An earlier version of this comment argued `worstPctUsed` describes the
  // database, not the table, and stripped every verdict here on that basis.
  // That was wrong: the threshold is PER-SEQUENCE (the note reads "N% of A
  // COLUMN's range used"), so on a page scoped to one relation it is a true,
  // more actionable statement about that table's own column — and stripping
  // it also deleted `crossed`, the only remediation text on the page ("the
  // column overflows before the sequence does… widening the column is the
  // fix"). On a console whose pitch is waking an operator before a primary
  // key overflows, hiding that was the wrong call.
  //
  // What is actually withheld here is narrower and is `sequences.ts`'s own
  // documented gap, not this page's: `verdict` has no third state, so when
  // `worstPctUsed` is null — no readable sequence exists to judge — the
  // check's `verdict` function returns `{ level: 'ok' }` anyway. That `ok` is
  // the absence of a finding, not a claim that the sequences are fine
  // (`sequences.ts`'s own docblock on its `verdict` says so), and this page
  // renders neither the caveat nor `data.unreadable` beside it. Left alone, a
  // table with NO SEQUENCES AT ALL gets a green OK badge it did nothing to
  // earn.
  //
  // The guard below is `level === 'ok'`, not `worstPctUsed === null`
  // specifically, because an `ok` carries nothing an operator does not
  // already see: every sequence's own `pctUsed` renders as a plain fact in
  // the panel below regardless, so a comfortably-under-threshold `ok` adds a
  // badge and no new information, and a vacuous `ok` adds a badge that is
  // actively wrong. A `warn` (or any future non-ok level) is never touched —
  // it is the one case with something to say that is not already on the
  // page, so it, and the remediation `crossed` carries, always renders.
  const seqsForDisplay = seqs.ok && seqs.verdict?.level === 'ok'
    ? { ...seqs, verdict: null, crossed: undefined } : seqs;

  return (
    <div className="grid gap-4">
      <div>
        <Link href={`/db/${name}/tables`} className="text-sm underline underline-offset-2">
          ← All tables
        </Link>
        <h1 className="mt-2 font-mono font-medium">{relation}</h1>
      </div>

      <CheckPanel title="This table" result={table}>
        {(d) => {
          const t = d.tables[0];
          if (t === undefined) return null;
          return (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Fact label="Size" value={formatBytes(t.sizeBytes)} />
              <Fact label="Live rows" value={formatCount(t.liveRows)} />
              <Fact label="Dead rows" value={formatCount(t.deadRows)} />
              <Fact
                label="Cache hit"
                value={t.hitRate === null ? 'no heap I/O recorded' : `${(t.hitRate * 100).toFixed(1)}%`}
              />
              <Fact label="Last vacuum" value={formatAgo(t.lastVacuum) ?? 'never'} />
              <Fact label="Last analyze" value={formatAgo(t.lastAnalyze) ?? 'never'} />
              <Fact
                label="Index scans"
                value={t.idxScans === null ? 'no indexes' : formatCount(t.idxScans)}
              />
              <Fact label="Sequential scans" value={formatCount(t.seqScans)} />
            </dl>
          );
        }}
      </CheckPanel>

      <CheckPanel title="Transaction age" result={xid}>
        {(d) => {
          const r = d.relations[0];
          return r === undefined
            ? <p className="text-sm text-muted-foreground">No reading for this relation.</p>
            : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <Fact label="Transaction age" value={formatCount(r.xactAge)} />
                <Fact label="Transactions remaining" value={formatCount(r.txnsRemaining)} />
              </dl>
            );
        }}
      </CheckPanel>

      <CheckPanel title="Indexes" result={indexes}>
        {(d) => (d.indexes.length === 0
          ? <p className="text-sm text-muted-foreground">No indexes on this table.</p>
          : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Index</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Flags</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.indexes.map((i) => (
                  <TableRow key={i.name}>
                    <TableCell className="font-mono text-xs">{i.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatBytes(i.sizeBytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {/* No `|| '—'`: an em dash means "we could not look"
                          everywhere else on this page (`unused?` is that
                          same signal for one flag), and a clean index would
                          then read one dash apart from an unreadable one. An
                          empty cell says "checked, nothing to flag" instead. */}
                      {flagsFor(i.name, { unused, duplicates, invalid }).join(' · ')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ))}
      </CheckPanel>

      <CheckPanel title="Sequences" result={seqsForDisplay}>
        {(d) => (d.sequences.length === 0
          ? <p className="text-sm text-muted-foreground">No sequence feeds a column of this table.</p>
          : (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              {d.sequences.map((s) => (
                <Fact
                  key={s.name}
                  label={s.column === null ? s.name : `${s.name} → ${s.column}`}
                  value={s.pctUsed === null ? 'unreadable' : `${s.pctUsed.toFixed(2)}% of its range`}
                />
              ))}
            </dl>
          ))}
      </CheckPanel>

      <Growth relation={relation} history={history} />
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}

/**
 * The flags on one index, from the three finding checks.
 *
 * A check that SUCCEEDED and lists this index contributes its plain label
 * ("unused", "duplicate", "invalid"). A check that FAILED contributes the
 * same label with a question mark ("unused?") rather than silence — a flag
 * list nobody could read is not the same thing as a clean index, and this is
 * the distinction the helper exists to keep. `verdict: null` is not `ok`,
 * and neither is "we could not check".
 */
function flagsFor(
  index: string,
  checks: {
    unused: CheckResult<IndexFindingData>;
    duplicates: CheckResult<DuplicateData>;
    invalid: CheckResult<IndexFindingData>;
  },
): string[] {
  const out: string[] = [];

  if (!checks.unused.ok) out.push('unused?');
  else if (checks.unused.data.indexes.some((x) => x.name === index)) out.push('unused');

  if (!checks.duplicates.ok) out.push('duplicate?');
  else if (checks.duplicates.data.pairs.some((x) => x.name === index)) out.push('duplicate');

  if (!checks.invalid.ok) out.push('invalid?');
  else if (checks.invalid.data.indexes.some((x) => x.name === index)) out.push('invalid');

  return out;
}

/** Copied in shape from cleanup/space/[relation], which this panel replaces. */
function Growth({ relation, history }: {
  relation: string;
  history: Awaited<ReturnType<typeof runSeriesFor<{ capturedAt: Date; sizeBytes: number }>>>;
}) {
  if (!history.ok) {
    return (
      <div className="rounded border p-3 text-sm">
        <p>{history.message}</p>
        {history.remedy === undefined ? null : (
          <p className="mt-1 text-muted-foreground">{history.remedy}</p>
        )}
      </div>
    );
  }
  if (history.points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough history captured yet for {relation}.
      </p>
    );
  }
  return (
    <div>
      <h2 className="mb-2 border-b pb-2 font-medium">Size over {DAYS} days</h2>
      <LineChart
        points={history.points.map((p) => ({ at: p.capturedAt, value: p.sizeBytes }))}
        label={`${relation} size over ${DAYS} days`}
        format={formatBytes}
      />
    </div>
  );
}
