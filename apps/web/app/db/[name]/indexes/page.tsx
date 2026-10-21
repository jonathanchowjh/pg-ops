import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, TOOLS, indexFlags, type BloatedIndex, type CheckResult, type IndexBloatData, type SuggestedIndexes } from '@pgops/checks';
import { Bar, CELL, CatalogNote, IndexRow, List, NUM } from '@/components/catalog-rows';
import { Clock, Time } from '@/components/clock';
import { FindBox, NodeHead } from '@/components/node-head';
import { Scatter } from '@/components/scatter';
import { Sql } from '@/components/sql';
import { catalogFor, scansFor } from '@/lib/catalog';
import { runCheckFor, runToolFor } from '@/lib/check';
import { keepQuery, one, windowQuery, type Search } from '@/lib/clock';
import { formatBytes, formatCount } from '@/lib/format';
import type { Mark } from '@/lib/plot';
import { clockFor } from '@/lib/samples';
import { cn } from '@/lib/utils';

const LISTED = 200;
const BUTTON = 'rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted aria-[current=true]:bg-foreground aria-[current=true]:text-card';

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Indexes` };
}

/**
 * The Indexes population: which indexes can I drop. Scans in the window
 * against size, with a band at the left for an index never scanned since
 * the statistics reset the head names; then the list to drop.
 *
 * The bloat estimate and the suggested-index sweep each run from a button:
 * the first is five CTEs over `pg_stats`, the second plans up to a hundred
 * statements. Neither runs because someone opened the page. No `<Refresh>`.
 */
export default async function Indexes({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp, { sessions: false });
  const { grid } = clock;
  const find = one(sp.find).trim();
  const needle = find.toLowerCase();
  const run = one(sp.run);
  const [catalog, scans] = await Promise.all([catalogFor(name), scansFor(name, grid)]);
  const bloat = run === 'bloat' ? await runCheckFor(name, CHECKS.indexBloat, {}) : null;
  const suggested = run === 'suggest' ? await runToolFor(name, TOOLS.suggestedIndexes, {}) : null;

  const indexes = catalog.indexes.filter((i) => `${i.name} ${i.table}`.toLowerCase().includes(needle));
  const flagged = indexes.filter((i) => indexFlags(i).length > 0);
  const never = catalog.indexes.filter((i) => indexFlags(i).includes('never used'));
  const duplicate = catalog.indexes.filter((i) => indexFlags(i).includes('duplicate'));
  // A failed CONCURRENTLY build: it serves no query and still costs every write.
  const invalid = catalog.indexes.filter((i) => indexFlags(i).includes('invalid'));
  const reclaim = new Set([...never, ...duplicate, ...invalid]);
  /** The window's scans where the store keeps the hours; since the reset where it does not. */
  const scansOf = (i: (typeof indexes)[number]): number => (scans.ok ? scans.value.get(i.name) ?? 0 : i.scans);
  /** Never read is not zero indexes: its failure is in the note. */
  const unread = catalog.indexesTotal === null;
  const marks = indexes.map((i): Mark => {
    const flags = indexFlags(i);
    return {
      id: i.name, label: flags.length > 0 ? i.name.replace(/^.*\./, '') : '',
      // Never scanned since the reset is the band; scanned, but not in this window, is the left edge.
      x: i.scans === 0 ? null : scansOf(i), y: i.sizeBytes, flag: flags.length > 0, weight: flags.length > 0 ? i.sizeBytes : 0,
      href: `/db/${name}/tables/${encodeURIComponent(i.table)}`,
      lines: [i.table, `${formatBytes(i.sizeBytes)} size`, `${formatCount(scansOf(i))} scans`, ...flags],
    };
  });
  const here = `${windowQuery(grid.winSecs, grid.live ? null : grid.to)}${keepQuery(find, null)}`;

  return (
    <>
      <NodeHead title="Indexes" crumb={[{ label: name, href: `/db/${name}` }]}>
        <span className="font-mono text-xs text-body tabular-nums">
          {unread ? 'not read' : (
            <>
              {formatCount(catalog.indexesTotal!)} · {formatCount(never.length)} never used since{' '}
              {catalog.statsReset === null ? 'statistics began' : <Time at={catalog.statsReset} />}
              {' · '}{formatCount(duplicate.length)} duplicate
              {invalid.length === 0 ? null : ` · ${formatCount(invalid.length)} invalid`}
              {' · '}{formatBytes([...reclaim].reduce((a, i) => a + i.sizeBytes, 0))} to reclaim
            </>
          )}
        </span>
        <FindBox find={find} label="find an index or a table" winSecs={grid.winSecs} end={grid.live ? null : grid.to} />
        <Link href={`${here}&run=bloat`} aria-current={run === 'bloat' ? 'true' : undefined} className={BUTTON}>Estimate bloat</Link>
        <Link href={`${here}&run=suggest`} aria-current={run === 'suggest' ? 'true' : undefined} className={BUTTON}>Suggest indexes</Link>
      </NodeHead>
      <Clock grid={grid} now={clock.now} day={clock.day} events={clock.events} keep={keepQuery(find, null)} initialCursor={clock.pinAt}>
        <CatalogNote at={catalog.at} failed={catalog.failed} shown={catalog.indexes.length} total={catalog.indexesTotal} what="indexes" />
        {bloat === null ? null : <Bloated result={bloat} />}
        {suggested === null ? null : <Suggested name={name} result={suggested} />}
        <section className="mb-4 rounded-md border bg-card">
          <h2 className="px-3 pt-2 text-[13px]/[18px] font-semibold text-foreground">
            Every index
            <small className="ml-1.5 font-normal text-muted-foreground">high and left is large and unused</small>
          </h2>
          <Scatter
            marks={marks} band="never" y={{ label: 'size', unit: 'bytes' }}
            x={{ label: scans.ok ? 'scans in the window' : 'scans since the reset', unit: 'compact' }}
          />
          {scans.ok || scans.kind === 'off' ? null : (
            <p className="px-3 pb-2 text-xs text-muted-foreground">The store could not be read, so scans are since the reset: {scans.message}</p>
          )}
        </section>
        <List head={['Never used, a duplicate, or invalid', 'Table', '', 'Size>', 'Scans>', '']}>
          {flagged.slice(0, LISTED).map((i) => (
            <IndexRow key={i.name} database={name} index={i} largest={flagged[0]!.sizeBytes} scans={scansOf(i)} withTable />
          ))}
        </List>
        {flagged.length === 0 ? <p className="mt-2 text-muted-foreground">{find !== '' ? `nothing named “${find}”` : unread ? 'could not be read' : 'nothing to drop'}</p> : null}
        {flagged.length > LISTED ? <p className="mt-2 text-xs text-muted-foreground">+ {formatCount(flagged.length - LISTED)} more</p> : null}
      </Clock>
    </>
  );
}

const SECTION = 'mb-2 mt-1 text-sm/5 font-semibold text-foreground';
const NOTE = 'ml-2.5 text-xs font-normal text-muted-foreground';
const FAILED = 'mb-4 rounded-md border bg-card px-3 py-2 text-muted-foreground';

/** The bloat estimate, when its button was pressed. An estimate from column statistics, and it says so. */
function Bloated({ result }: { result: CheckResult<IndexBloatData> }) {
  if (!result.ok) return <p className={FAILED}>The bloat estimate could not be made: {result.message}</p>;
  const rows = result.data.indexes;
  return (
    <>
      <h2 className={SECTION}>Bloat<small className={NOTE}>estimated from column statistics, over 100 MB of waste</small></h2>
      {rows.length === 0 ? <p className={FAILED}>no index over the floor</p> : (
        <div className="mb-4">
          <List head={['Index', 'Table', 'Wasted, of its size', 'Wasted>', 'Size>']}>
            {rows.map((i: BloatedIndex) => (
              <tr key={i.name}>
                <td className={cn(CELL, 'font-mono text-foreground')}>{i.name}</td>
                <td className={cn(CELL, 'font-mono')}>{i.table}</td>
                <td className="border-t px-3 py-[5px]"><Bar share={i.indexBytes > 0 ? i.bloatBytes / i.indexBytes : 0} over /></td>
                <td className={NUM}>{formatBytes(i.bloatBytes)}</td>
                <td className={NUM}>{formatBytes(i.indexBytes)}</td>
              </tr>
            ))}
          </List>
        </div>
      )}
    </>
  );
}

/** The suggested-index sweep, when its button was pressed: the statement to run, and the statements that want it. */
function Suggested({ name, result }: { name: string; result: CheckResult<SuggestedIndexes> }) {
  if (!result.ok) return <p className={FAILED}>Indexes could not be suggested: {result.message}</p>;
  const d = result.data;
  const unplanned = d.byQuery.filter((s) => s.error !== undefined).length;
  return (
    <>
      <h2 className={SECTION}>
        Suggested
        <small className={NOTE}>
          {formatCount(d.byQuery.length - unplanned)} statements planned, {formatCount(unplanned)} could not be; pgops never runs these
        </small>
      </h2>
      {d.indexes.length === 0 ? <p className={FAILED}>none: every statement planned is served by an index</p> : (
        <ul className="mb-4 space-y-3 rounded-md border bg-card px-3 py-2">
          {/* Keyed by position: the statement is the only id a suggestion has, and a key is published. */}
          {d.indexes.map((s, i) => (
            <li key={i} className="space-y-1">
              <pre className="overflow-x-auto font-mono text-xs/5 text-foreground">{s.statement}</pre>
              {s.queries.map(({ queryid, query: text }, j) => <ShapeLine key={j} name={name} id={queryid} text={text} />)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** One statement that wants an index: its text through `Sql`, linked to its page when it has an id. */
function ShapeLine({ name, id, text }: { name: string; id: string | null; text: string }) {
  return id === null
    ? <Sql>{text}</Sql>
    : <Link href={`/db/${name}/queries/${encodeURIComponent(id)}`} className="block hover:underline"><Sql>{text}</Sql></Link>;
}
