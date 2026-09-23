import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CHECKS,
  type DuplicatePair, type IndexCachingEntry, type IndexEntry, type IndexFinding,
  type InvalidConstraint, type TableIndexUsage,
} from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { cacheChecks } from '@/lib/hygiene';
import { CheckPanel } from '@/components/check-panel';
import { TableCell, TableRow } from '@/components/ui/table';
import { Findings } from '@/components/findings';
import { foldFrom } from '@/lib/fold';
import { Sql } from '@/components/sql';
import { formatAgo, formatBytes, formatCount } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Indexes` };
}

/** The empty state every finding panel shares — a sentence, never a blank box. */
function Nothing({ children }: { children: string }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

/**
 * Hygiene, not incident: NO `<Refresh>`.
 *
 * `/queries` above it polls at 5s because it is an incident page. This one
 * runs ten catalog checks, several of which scan `pg_index` and `pg_stats`,
 * and nothing here changes between one glance and the next — a poll would buy
 * nothing and cost a repeating catalog scan on every open tab.
 * test/guards.test.ts holds the polling set by name.
 *
 * Order is FINDINGS FIRST, INVENTORY LAST. The operator arrives asking "is
 * anything wrong with my indexes?", and `indexList` is the reference material
 * they consult after the answer rather than before it.
 *
 * `invalidConstraints` sits directly beside `invalidIndexes` although its gate
 * is `keep-up` and this is a `work` page. That is the one place the spec asks
 * for a gate/page mismatch: pgHero shows the two in a single alert, and they
 * answer one operator question — did a migration leave something half-built?
 *
 * `indexBloat` is NOT run here. It is `class: 'on-demand'` with a 30s budget;
 * it gets a link and a sentence naming its cost, and is reached by an explicit
 * click.
 */
export default async function Indexes({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ pgops?: string }>;
}) {
  const { name } = await params;
  // pgops's own indexes, folded out of every list below — see lib/fold.ts.
  // The database this console is pointed at may also be its store, and eight
  // of the nine rows in an inventory then belong to the tool.
  const fold = foldFrom(`/db/${name}/queries/indexes`, await searchParams);

  const [
    hitRate, invalid, constraints, unused, duplicates, usage, missing, caching, list, reset,
  ] = await Promise.all([
    runCheckFor(name, CHECKS.indexHitRate),
    runCheckFor(name, CHECKS.invalidIndexes, {}),
    runCheckFor(name, CHECKS.invalidConstraints, {}),
    runCheckFor(name, CHECKS.unusedIndexes, {}),
    runCheckFor(name, CHECKS.duplicateIndexes, {}),
    runCheckFor(name, CHECKS.indexUsage, {}),
    runCheckFor(name, CHECKS.missingIndexes, {}),
    runCheckFor(name, CHECKS.indexCaching, {}),
    runCheckFor(name, CHECKS.indexList, {}),
    runCheckFor(name, CHECKS.lastStatsReset),
  ]);

  // The same readings, written where the triage page can see them. The page
  // is unchanged — it ran these checks just now, on visit — and this is what
  // stops the triage line reporting a finding this page has already
  // disproved. Never throws, and does nothing at all without a store.
  await cacheChecks(name, {
    indexHitRate: hitRate, invalidIndexes: invalid, invalidConstraints: constraints,
    unusedIndexes: unused, duplicateIndexes: duplicates, indexUsage: usage,
    missingIndexes: missing, indexCaching: caching, indexList: list, lastStatsReset: reset,
  });

  return (
    <>
      <div className="grid gap-4">
        <CheckPanel title="Index cache hit rate" result={hitRate}>
          {(d) => (d.rate === null
            // Not 0%. A database that has served no index reads has no rate,
            // and 0% is a reading that would sit under a 99% threshold as
            // though the cache were failing.
            ? <Nothing>No index I/O recorded yet.</Nothing>
            : <p className="text-xl font-semibold tabular-nums text-foreground">{d.rate.toFixed(2)}%</p>)}
        </CheckPanel>

        <CheckPanel title="Invalid indexes" result={invalid} count={(d) => d.total}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No invalid indexes.</Nothing>
            : (
              <Findings
                items={d.indexes}
                total={d.total}
                fold={fold}
                subject={(i: IndexFinding) => i.name}
                columns={['index', 'on table', 'size>']}
              >
                  {(i: IndexFinding) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-mono font-medium">{i.name}</TableCell>
                      <TableCell className="font-mono">{i.table}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBytes(i.sizeBytes)}
                      </TableCell>
                    </TableRow>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Unvalidated constraints" result={constraints} count={(d) => d.total}>
          {(d) => (d.constraints.length === 0
            ? <Nothing>No unvalidated constraints.</Nothing>
            : (
              <Findings
                items={d.constraints}
                total={d.total}
                fold={fold}
                subject={(c: InvalidConstraint) => c.table}
              >
                  {(c: InvalidConstraint) => (
                    <li key={`${c.table}.${c.name}`} className="py-1">
                      <span className="font-mono font-medium">{c.name}</span>{' '}
                      <span className="text-muted-foreground">on {c.table}</span>
                      <Sql>{c.definition}</Sql>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Unused indexes" result={unused} count={(d) => d.total}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No unused indexes over the reporting floor.</Nothing>
            : (
              <Findings
                items={d.indexes}
                total={d.total}
                fold={fold}
                subject={(i: IndexFinding) => i.name}
                columns={['index', 'on table', 'size>']}
              >
                  {(i: IndexFinding) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-mono font-medium">{i.name}</TableCell>
                      <TableCell className="font-mono">{i.table}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBytes(i.sizeBytes)}
                      </TableCell>
                    </TableRow>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Duplicate indexes" result={duplicates} count={(d) => d.total}>
          {(d) => (d.pairs.length === 0
            ? <Nothing>No redundant indexes.</Nothing>
            : (
              <Findings
                items={d.pairs}
                total={d.total}
                fold={fold}
                subject={(p: DuplicatePair) => p.name}
                columns={['index', 'on table', 'covered by', 'size>']}
              >
                  {(p: DuplicatePair) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-mono font-medium">{p.name}</TableCell>
                      <TableCell className="font-mono">{p.table}</TableCell>
                      <TableCell className="font-mono">{p.coveredBy}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatBytes(p.sizeBytes)}
                      </TableCell>
                    </TableRow>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Tables that may need an index" result={missing} count={(d) => d.total}>
          {(d) => (d.tables.length === 0
            ? <Nothing>No tables qualify.</Nothing>
            : (
              <Findings
                items={d.tables}
                total={d.total}
                fold={fold}
                subject={(t: TableIndexUsage) => t.table}
                columns={['relation', 'index scans>', 'rows>']}
              >
                  {(t: TableIndexUsage) => <TableUsageRow key={t.table} table={t} />}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Index usage by table" result={usage} count={(d) => d.total}>
          {(d) => (d.tables.length === 0
            ? <Nothing>No tables with recorded scans.</Nothing>
            : (
              <Findings
                items={d.tables}
                total={d.total}
                fold={fold}
                subject={(t: TableIndexUsage) => t.table}
                columns={['relation', 'index scans>', 'rows>']}
              >
                  {(t: TableIndexUsage) => <TableUsageRow key={t.table} table={t} />}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Index caching" result={caching} count={(d) => d.total}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No index I/O recorded yet.</Nothing>
            : (
              <Findings
                items={d.indexes}
                total={d.total}
                fold={fold}
                subject={(i: IndexCachingEntry) => i.name}
                columns={['index', 'cache hit rate>']}
              >
                  {(i: IndexCachingEntry) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-mono">{i.name}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* null is "no I/O yet", never 0% — see toIndexCaching. */}
                        {i.hitRate === null
                          ? <span className="text-muted-foreground">no reads yet</span>
                          : `${i.hitRate.toFixed(2)}%`}
                      </TableCell>
                    </TableRow>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        {/* The inventory, last. */}
        <CheckPanel title="All indexes" result={list} count={(d) => d.total}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>This database has no indexes.</Nothing>
            : (
              <Findings
                items={d.indexes}
                total={d.total}
                fold={fold}
                subject={(i: IndexEntry) => i.name}
                columns={['index', 'on table', 'kind', 'size>']}
              >
                  {(i: IndexEntry) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-mono font-medium align-top">
                        {i.name}
                        {/* The inventory is read to FIND an index, and every
                            row carrying its full CREATE statement turned a
                            list of names into a wall of SQL — the one panel
                            on this page where scanning is the whole task. The
                            statement is one click away and nothing is lost. */}
                        <details className="mt-1 font-sans font-normal">
                          <summary className="cursor-pointer text-xs text-muted-foreground">
                            definition
                          </summary>
                          <Sql>{i.definition}</Sql>
                        </details>
                      </TableCell>
                      <TableCell className="font-mono align-top">{i.table}</TableCell>
                      <TableCell className="align-top text-muted-foreground">
                        {i.primary ? 'primary key' : i.unique ? 'unique' : ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums align-top">
                        {formatBytes(i.sizeBytes)}
                      </TableCell>
                    </TableRow>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Statistics last reset" result={reset} compact>
          {(d) => (
            // `null` is "never reset since this server started counting",
            // which is a reading. An epoch date would be a fabricated one.
            <span className="tabular-nums">{formatAgo(d.statsReset) ?? 'Never'}</span>
          )}
        </CheckPanel>

        {/*
          * `index_bloat` is class 'on-demand' with a 30s budget, and pgHero
          * reaches the same conclusion by shipping it disabled on its own
          * dashboard (home_controller.rb:114). A link, with its cost named, so
          * the wait is chosen rather than imposed on every visit to this page.
          */}
        <section className="rounded-lg border p-4">
          <h2 className="font-semibold">Index bloat</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Estimating bloat reads column statistics for every btree index and can take tens of
            seconds on a large database, so it is not run with the checks above.
          </p>
          <Link
            href={`/db/${name}/queries/indexes/bloat`}
            className="mt-2 inline-block text-sm underline underline-offset-4"
          >
            Estimate index bloat
          </Link>
        </section>

        {/*
          * #58/#63 plan up to a hundred query shapes, so they get the same
          * treatment as bloat: a link with its cost named, not a panel run on
          * every visit to a page that otherwise reads cached results.
          */}
        <section className="rounded-lg border p-4">
          <h2 className="font-semibold">Suggested indexes</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Plans the busiest query shapes from pg_stat_statements and suggests an index for each
            sequential scan worth one. It plans rather than runs them, but a hundred plans is not
            free, so it is not run with the checks above.
          </p>
          <Link
            href={`/db/${name}/queries/indexes/suggested`}
            className="mt-2 inline-block text-sm underline underline-offset-4"
          >
            Suggest indexes
          </Link>
        </section>
      </div>
    </>
  );
}

/** Shared by #24 `index_usage` and #25 `missing_indexes` — one row shape, two questions. */
function TableUsageRow({ table }: { table: TableIndexUsage }) {
  return (
    <TableRow>
      <TableCell className="font-mono">{table.table}</TableCell>
      <TableCell className="text-right tabular-nums">
        {/* null means this table has NO indexes at all — not 0% of scans
            using one. The two are different findings and the check keeps them
            apart, so the page must too. A dash would be the third thing, and
            it would read as either. */}
        {table.indexHitRate === null
          ? <span className="text-muted-foreground">no indexes</span>
          : `${table.indexHitRate.toFixed(0)}%`}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {formatCount(table.estimatedRows)}
      </TableCell>
    </TableRow>
  );
}
