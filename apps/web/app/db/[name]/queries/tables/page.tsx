import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, type TableCaching, type TableStat, type UnusedTable } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { cacheChecks } from '@/lib/hygiene';
import { CheckPanel } from '@/components/check-panel';
import { TableCell, TableRow } from '@/components/ui/table';
import { Findings } from '@/components/findings';
import { foldFrom } from '@/lib/fold';
import { formatAge, formatCount } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Tables` };
}

/** `null` is "never", which is a reading on a maintenance panel — not a gap. */
function When({ at }: { at: Date | null }) {
  if (at === null) return <span className="text-muted-foreground">Never</span>;
  // An AGE, not a timestamp. This renders on the server, which does not know
  // the reader's timezone, so `2026-09-23T03:50:49.042Z` was both unreadable
  // and a claim about a clock pgops cannot see — four of them per row, down a
  // column whose question is "how long has it been". The exact instant stays
  // in `dateTime` and in the tooltip.
  const ago = formatAge((Date.now() - at.getTime()) / 1_000);
  return (
    <time dateTime={at.toISOString()} title={at.toISOString()} className="tabular-nums">
      {ago} ago
    </time>
  );
}

/**
 * The tables half of the hygiene work gate. No `<Refresh>`: these are catalog
 * and statistics reads that do not change between one glance and the next, and
 * `test/guards.test.ts` holds the polling set by name.
 */
export default async function Tables({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ pgops?: string }>;
}) {
  const { name } = await params;
  // pgops's own tables, folded out of every list below — see lib/fold.ts.
  const fold = foldFrom(`/db/${name}/queries/tables`, await searchParams);

  const [hitRate, unused, stats, caching] = await Promise.all([
    runCheckFor(name, CHECKS.tableHitRate),
    runCheckFor(name, CHECKS.unusedTables, {}),
    runCheckFor(name, CHECKS.tableStats, {}),
    runCheckFor(name, CHECKS.tableCaching, {}),
  ]);

  // The same readings, written where the triage page can see them. The page
  // is unchanged — it ran these checks just now, on visit — and this is what
  // stops the triage line reporting a finding this page has already
  // disproved. Never throws, and does nothing at all without a store.
  await cacheChecks(name, {
    tableHitRate: hitRate, unusedTables: unused, tableStats: stats, tableCaching: caching,
  });

  return (
    <>
      <div className="grid gap-4">
        <CheckPanel title="Table cache hit rate" result={hitRate}>
          {(d) => (d.rate === null
            // Not 0%. A database that has read no heap pages has no rate, and
            // 0% would sit under a 99% threshold as though the cache were
            // failing on a server that has simply not been asked for anything.
            ? <p className="text-sm text-muted-foreground">No heap I/O recorded yet.</p>
            : <p className="text-xl font-semibold tabular-nums text-foreground">{d.rate.toFixed(2)}%</p>)}
        </CheckPanel>

        <CheckPanel title="Unused tables" result={unused} count={(d) => d.total}>
          {(d) => (d.tables.length === 0
            ? (
              /*
               * The empty state has to say WHICH question it answered.
               *
               * #35 is pgHero's `idx_scan = 0`, and `idx_scan` is NULL — not
               * 0 — for a table with no indexes at all (verified identical on
               * 14.24 and 18.6), so every such table is excluded here. That
               * exclusion is correct: "are this table's indexes being used?"
               * has no answer for a table with none. But it means an empty
               * panel does NOT mean "no unused tables", and an operator who
               * reads it that way has been misled by silence.
               */
              <p className="text-sm text-muted-foreground">
                Every table with indexes has had at least one index scan. Tables with{' '}
                <strong>no indexes at all</strong> are not counted here — the question does not
                apply to them, and they appear under{' '}
                <Link
                  href={`/db/${name}/queries/indexes`}
                  className="underline underline-offset-4"
                >
                  tables that may need an index
                </Link>
                .
              </p>
            )
            : (
              <Findings
                items={d.tables}
                total={d.total}
                fold={fold}
                subject={(t: UnusedTable) => t.table}
                columns={['table', 'rows>']}
              >
                {(t: UnusedTable) => (
                  <TableRow key={t.table}>
                    <TableCell className="font-mono">{t.table}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(t.estimatedRows)}
                    </TableCell>
                  </TableRow>
                )}
              </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Maintenance" result={stats} count={(d) => d.total}>
          {(d) => (d.tables.length === 0
            ? <p className="text-sm text-muted-foreground">No tables.</p>
            : (
              <Findings
                items={d.tables}
                total={d.total}
                fold={fold}
                subject={(t: TableStat) => t.table}
                columns={['table', 'live>', 'dead>', 'vacuumed', 'analyzed']}
              >
                {(t: TableStat) => (
                  <TableRow key={t.table}>
                    <TableCell className="font-mono">{t.table}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(t.liveRows)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(t.deadRows)}
                    </TableCell>
                    {/* Manual and automatic in one cell, labelled, rather than
                        four columns: the question is "when was this last
                        touched", and which of the two did it is the detail. */}
                    <TableCell className="text-xs text-muted-foreground">
                      <div>by hand <When at={t.lastVacuum} /></div>
                      <div>auto <When at={t.lastAutovacuum} /></div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>by hand <When at={t.lastAnalyze} /></div>
                      <div>auto <When at={t.lastAutoanalyze} /></div>
                    </TableCell>
                  </TableRow>
                )}
              </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Table caching" result={caching} count={(d) => d.total}>
          {(d) => (d.tables.length === 0
            ? <p className="text-sm text-muted-foreground">No heap I/O recorded yet.</p>
            : (
              <Findings
                items={d.tables}
                total={d.total}
                fold={fold}
                subject={(t: TableCaching) => t.table}
                columns={['table', 'cache hit rate>']}
              >
                {(t: TableCaching) => (
                  <TableRow key={t.table}>
                    <TableCell className="font-mono">{t.table}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* null is "no I/O yet", never 0% — pgHero's own query
                          collapses these with `CASE WHEN ... THEN 0`, and
                          tables.ts deliberately does not. */}
                      {t.hitRate === null
                        ? <span className="text-muted-foreground">no reads yet</span>
                        : `${t.hitRate.toFixed(2)}%`}
                    </TableCell>
                  </TableRow>
                )}
              </Findings>
            ))}
        </CheckPanel>
      </div>
    </>
  );
}
