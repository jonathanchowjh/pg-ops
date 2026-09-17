import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  CHECKS,
  type DuplicatePair, type IndexCachingEntry, type IndexEntry, type IndexFinding,
  type InvalidConstraint, type TableIndexUsage,
} from '@pgops/checks';
import { runCheckFor } from '@/lib/check';
import { CheckPanel } from '@/components/check-panel';
import { SubNav } from '@/components/sub-nav';
import { Sql } from '@/components/sql';
import { formatBytes, formatCount } from '@/lib/format';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string }> },
): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Indexes` };
}

/**
 * Every capped list on this page, list and truncation sentence together.
 *
 * `total` is the pre-LIMIT `count(*) OVER ()` — the only number that knows how
 * much the cap hid (§5). Telling an operator a truncated list was the whole
 * answer is the failure this page exists to avoid.
 *
 * The count shown is derived from `items` INSIDE this component rather than
 * passed in beside it. An earlier version took `shown` and `total` as two
 * props, and a mutation that passed `items.length` for both — restoring
 * exactly the `rows.length` bug §5 forbids — survived the suite, because only
 * one of the six call sites had a truncation test. One prop fewer removes the
 * mistake instead of testing for it six times.
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
export default async function Indexes({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

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

  return (
    <>
      <SubNav
        name={name}
        base="queries"
        items={[{ segment: 'indexes', label: 'Indexes' }, { segment: 'tables', label: 'Tables' }]}
      />

      <div className="grid gap-4">
        <CheckPanel title="Index cache hit rate" result={hitRate}>
          {(d) => (d.rate === null
            // Not 0%. A database that has served no index reads has no rate,
            // and 0% is a reading that would sit under a 99% threshold as
            // though the cache were failing.
            ? <Nothing>No index I/O recorded yet.</Nothing>
            : <p className="text-2xl font-semibold tabular-nums">{d.rate.toFixed(2)}%</p>)}
        </CheckPanel>

        <CheckPanel title="Invalid indexes" result={invalid}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No invalid indexes.</Nothing>
            : (
              <Findings items={d.indexes} total={d.total}>
                  {(i: IndexFinding) => (
                    <li key={i.name} className="py-1">
                      <span className="font-mono font-medium">{i.name}</span>{' '}
                      <span className="text-muted-foreground">
                        on {i.table} · {formatBytes(i.sizeBytes)}
                      </span>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Unvalidated constraints" result={constraints}>
          {(d) => (d.constraints.length === 0
            ? <Nothing>No unvalidated constraints.</Nothing>
            : (
              <Findings items={d.constraints} total={d.total}>
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

        <CheckPanel title="Unused indexes" result={unused}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No unused indexes over the reporting floor.</Nothing>
            : (
              <Findings items={d.indexes} total={d.total}>
                  {(i: IndexFinding) => (
                    <li key={i.name} className="py-1">
                      <span className="font-mono font-medium">{i.name}</span>{' '}
                      <span className="text-muted-foreground">
                        on {i.table} · {formatBytes(i.sizeBytes)}
                      </span>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Duplicate indexes" result={duplicates}>
          {(d) => (d.pairs.length === 0
            ? <Nothing>No redundant indexes.</Nothing>
            : (
              <Findings items={d.pairs} total={d.total}>
                  {(p: DuplicatePair) => (
                    <li key={p.name} className="py-1">
                      <span className="font-mono font-medium">{p.name}</span>{' '}
                      <span className="text-muted-foreground">
                        on {p.table} · {formatBytes(p.sizeBytes)} · covered by{' '}
                      </span>
                      <span className="font-mono">{p.coveredBy}</span>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Tables that may need an index" result={missing}>
          {(d) => (d.tables.length === 0
            ? <Nothing>No tables qualify.</Nothing>
            : (
              <Findings items={d.tables} total={d.total}>
                  {(t: TableIndexUsage) => <TableUsageRow key={t.table} table={t} />}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Index usage by table" result={usage}>
          {(d) => (d.tables.length === 0
            ? <Nothing>No tables with recorded scans.</Nothing>
            : (
              <Findings items={d.tables} total={d.total}>
                  {(t: TableIndexUsage) => <TableUsageRow key={t.table} table={t} />}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Index caching" result={caching}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>No index I/O recorded yet.</Nothing>
            : (
              <Findings items={d.indexes} total={d.total}>
                  {(i: IndexCachingEntry) => (
                    <li key={i.name} className="flex justify-between gap-4 py-1">
                      <span className="font-mono">{i.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {/* null is "no I/O yet", never 0% — see toIndexCaching. */}
                        {i.hitRate === null ? 'no reads yet' : `${i.hitRate.toFixed(2)}%`}
                      </span>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        {/* The inventory, last. */}
        <CheckPanel title="All indexes" result={list}>
          {(d) => (d.indexes.length === 0
            ? <Nothing>This database has no indexes.</Nothing>
            : (
              <Findings items={d.indexes} total={d.total}>
                  {(i: IndexEntry) => (
                    <li key={i.name} className="py-1">
                      <span className="font-mono font-medium">{i.name}</span>{' '}
                      <span className="text-muted-foreground">
                        on {i.table} · {formatBytes(i.sizeBytes)}
                        {i.primary ? ' · primary key' : i.unique ? ' · unique' : ''}
                      </span>
                      <Sql>{i.definition}</Sql>
                    </li>
                  )}
                </Findings>
            ))}
        </CheckPanel>

        <CheckPanel title="Statistics last reset" result={reset} compact>
          {(d) => (
            // `null` is "never reset since this server started counting",
            // which is a reading. An epoch date would be a fabricated one.
            <span className="tabular-nums">{d.statsReset ?? 'Never'}</span>
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
      </div>
    </>
  );
}

/** Shared by #24 `index_usage` and #25 `missing_indexes` — one row shape, two questions. */
function TableUsageRow({ table }: { table: TableIndexUsage }) {
  return (
    <li className="flex justify-between gap-4 py-1">
      <span className="font-mono">{table.table}</span>
      <span className="tabular-nums text-muted-foreground">
        {/* null means this table has NO indexes at all — not 0% of scans
            using one. The two are different findings and the check keeps them
            apart, so the page must too. */}
        {table.indexHitRate === null
          ? 'no indexes'
          : `${table.indexHitRate.toFixed(0)}% index scans`}
        {' · '}{formatCount(table.estimatedRows)} rows
      </span>
    </li>
  );
}
