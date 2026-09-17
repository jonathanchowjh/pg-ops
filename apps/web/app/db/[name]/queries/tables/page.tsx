import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { CHECKS, type TableCaching, type TableStat, type UnusedTable } from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { SubNav } from '@/components/sub-nav';
import { formatCount } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Tables` };
}

/**
 * Every capped list on this page, list and truncation sentence together.
 *
 * The count comes from `items` INSIDE this component rather than as a second
 * prop beside `total` — see the indexes page, where a mutation passing
 * `items.length` for both survived a suite that tested only one of eight call
 * sites. One prop fewer removes the mistake instead of testing for it.
 */
function Findings<T>({ items, total, children }: {
  items: readonly T[];
  total: number;
  children: (item: T) => ReactNode;
}) {
  return (
    <>
      <ul className="text-sm">{items.map(children)}</ul>
      {total > items.length ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Showing {formatCount(items.length)} of {formatCount(total)}. Narrow the database or
          raise the cap to see the rest.
        </p>
      ) : null}
    </>
  );
}

/** `null` is "never", which is a reading on a maintenance panel — not a gap. */
function When({ at }: { at: Date | null }) {
  if (at === null) return <span className="text-muted-foreground">Never</span>;
  return <time dateTime={at.toISOString()} className="tabular-nums">{at.toISOString()}</time>;
}

/**
 * The tables half of the hygiene work gate. No `<Refresh>`: these are catalog
 * and statistics reads that do not change between one glance and the next, and
 * `test/guards.test.ts` holds the polling set by name.
 */
export default async function Tables({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  const [hitRate, unused, stats, caching] = await Promise.all([
    runCheckFor(name, CHECKS.tableHitRate),
    runCheckFor(name, CHECKS.unusedTables, {}),
    runCheckFor(name, CHECKS.tableStats, {}),
    runCheckFor(name, CHECKS.tableCaching, {}),
  ]);

  return (
    <>
      <SubNav
        name={name}
        base="queries"
        items={[{ segment: 'indexes', label: 'Indexes' }, { segment: 'tables', label: 'Tables' }]}
      />

      <div className="grid gap-4">
        <CheckPanel title="Table cache hit rate" result={hitRate}>
          {(d) => (d.rate === null
            // Not 0%. A database that has read no heap pages has no rate, and
            // 0% would sit under a 99% threshold as though the cache were
            // failing on a server that has simply not been asked for anything.
            ? <p className="text-sm text-muted-foreground">No heap I/O recorded yet.</p>
            : <p className="text-2xl font-semibold tabular-nums">{d.rate.toFixed(2)}%</p>)}
        </CheckPanel>

        <CheckPanel title="Unused tables" result={unused}>
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
              <Findings items={d.tables} total={d.total}>
                {(t: UnusedTable) => (
                  <li key={t.table} className="flex justify-between gap-4 py-1">
                    <span className="font-mono">{t.table}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {formatCount(t.estimatedRows)} rows
                    </span>
                  </li>
                )}
              </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Maintenance" result={stats}>
          {(d) => (d.tables.length === 0
            ? <p className="text-sm text-muted-foreground">No tables.</p>
            : (
              <Findings items={d.tables} total={d.total}>
                {(t: TableStat) => (
                  <li key={t.table} className="border-t py-2 first:border-t-0">
                    <div className="flex flex-wrap justify-between gap-x-4">
                      <span className="font-mono">{t.table}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatCount(t.liveRows)} live · {formatCount(t.deadRows)} dead
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                      <span>vacuum <When at={t.lastVacuum} /></span>
                      <span>autovacuum <When at={t.lastAutovacuum} /></span>
                      <span>analyze <When at={t.lastAnalyze} /></span>
                      <span>autoanalyze <When at={t.lastAutoanalyze} /></span>
                    </div>
                  </li>
                )}
              </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Table caching" result={caching}>
          {(d) => (d.tables.length === 0
            ? <p className="text-sm text-muted-foreground">No heap I/O recorded yet.</p>
            : (
              <Findings items={d.tables} total={d.total}>
                {(t: TableCaching) => (
                  <li key={t.table} className="flex justify-between gap-4 py-1">
                    <span className="font-mono">{t.table}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {/* null is "no I/O yet", never 0% — pgHero's own query
                          collapses these with `CASE WHEN ... THEN 0`, and
                          tables.ts deliberately does not. */}
                      {t.hitRate === null ? 'no reads yet' : `${t.hitRate.toFixed(2)}%`}
                    </span>
                  </li>
                )}
              </Findings>
            ))}
        </CheckPanel>
      </div>
    </>
  );
}
