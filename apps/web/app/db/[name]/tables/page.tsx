import type { Metadata } from 'next';
import { tableFlags } from '@pgops/checks';
import { CatalogNote, List, SequenceRow, TableFactRow } from '@/components/catalog-rows';
import { Clock } from '@/components/clock';
import { FindBox, NodeHead } from '@/components/node-head';
import { Scatter } from '@/components/scatter';
import { catalogFor, writtenFor } from '@/lib/catalog';
import { keepQuery, one, type Search } from '@/lib/clock';
import { formatBytes, formatCount } from '@/lib/format';
import type { Mark } from '@/lib/plot';
import { clockFor } from '@/lib/samples';

/** Rows listed under a scatter. The rest are counted, and reached by the find box. */
const LISTED = 200;

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Tables` };
}

/**
 * The Tables population: which of many tables matter. Rows written in the
 * window against size, a filled point past its autovacuum trigger; then the
 * rows; then the sequences no column owns.
 *
 * The catalog, so no `<Refresh>`: it is read at most once a minute and the
 * page shows when. On the clock all the same: the window is what "written"
 * is measured over.
 */
export default async function Tables({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp, { sessions: false });
  const { grid } = clock;
  const find = one(sp.find).trim();
  const needle = find.toLowerCase();
  const [catalog, written] = await Promise.all([catalogFor(name), writtenFor(name, grid)]);

  const tables = catalog.tables.filter((t) => t.name.toLowerCase().includes(needle));
  const unowned = catalog.sequences.filter((s) => s.table === null && s.name.toLowerCase().includes(needle));
  const overdue = (t: (typeof tables)[number]): boolean => tableFlags(t, catalog.freezeMaxAge).includes('vacuum overdue');
  /** Never read is not zero tables: its failure is in the note. */
  const unread = catalog.tablesTotal === null;
  const marks = tables.map((t): Mark => {
    const rows = written.ok ? written.value.get(t.name) ?? 0 : 0;
    return {
      id: t.name, label: t.name.replace(/^public\./, ''), x: rows > 0 ? rows : null, y: t.sizeBytes,
      flag: overdue(t), weight: t.sizeBytes, href: `/db/${name}/tables/${encodeURIComponent(t.name)}`,
      lines: [
        `${formatBytes(t.sizeBytes)} size`,
        ...(written.ok ? [`${formatCount(rows)} rows written`] : []),
        `${formatCount(t.deadRows)} dead rows of ${formatCount(t.vacuumTrigger)}`,
      ],
    };
  });

  return (
    <>
      <NodeHead title="Tables" crumb={[{ label: name, href: `/db/${name}` }]}>
        <span className="font-mono text-xs text-body tabular-nums">
          {unread ? 'not read' : (
            <>
              {formatCount(catalog.tablesTotal!)} · {formatBytes(catalog.tables.reduce((a, t) => a + t.sizeBytes, 0))}
              {' · '}{formatCount(catalog.tables.filter(overdue).length)} vacuum overdue
            </>
          )}
        </span>
        <FindBox find={find} label="find a table" winSecs={grid.winSecs} end={grid.live ? null : grid.to} />
      </NodeHead>
      <Clock grid={grid} now={clock.now} day={clock.day} events={clock.events} keep={keepQuery(find, null)} initialCursor={clock.pinAt}>
        <CatalogNote at={catalog.at} failed={catalog.failed} shown={catalog.tables.length} total={catalog.tablesTotal} what="tables" />
        <section className="mb-4 rounded-md border bg-card">
          <h2 className="px-3 pt-2 text-[13px]/[18px] font-semibold text-foreground">
            Every table
            <small className="ml-1.5 font-normal text-muted-foreground">a filled point is past its autovacuum trigger</small>
          </h2>
          <Scatter marks={marks} x={{ label: 'rows written in the window', unit: 'compact' }} y={{ label: 'size', unit: 'bytes' }} band="none" />
          {written.ok ? null : (
            <p className="px-3 pb-2 text-xs text-muted-foreground">
              {written.kind === 'off' ? 'No store is configured, so rows written are not kept.' : `The store could not be read, so rows written are not shown: ${written.message}`}
            </p>
          )}
        </section>
        <List head={['Table', 'Rows>', 'Size>', 'Dead rows, against the trigger', 'Vacuumed>', '']}>
          {tables.slice(0, LISTED).map((t) => <TableFactRow key={t.name} database={name} table={t} freezeMaxAge={catalog.freezeMaxAge} />)}
        </List>
        {tables.length === 0 ? <p className="mt-2 text-muted-foreground">{find !== '' ? `nothing named “${find}”` : unread ? 'could not be read' : 'no tables'}</p> : null}
        {tables.length > LISTED ? <p className="mt-2 text-xs text-muted-foreground">+ {formatCount(tables.length - LISTED)} more</p> : null}
        {unowned.length === 0 ? null : (
          <>
            <h2 className="mt-5 mb-2 text-sm/5 font-semibold text-foreground">
              Sequences no column owns
              <small className="ml-2.5 text-xs font-normal text-muted-foreground">against their own limit</small>
            </h2>
            <List head={['Sequence', '', '>', '']}>
              {unowned.map((s) => <SequenceRow key={s.name} sequence={s} />)}
            </List>
          </>
        )}
      </Clock>
    </>
  );
}
