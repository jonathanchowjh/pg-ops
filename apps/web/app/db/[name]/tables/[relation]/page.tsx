import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { readHourly, readRelationSpace, readTableHours, tableFlags, type TableHour } from '@pgops/checks';
import { CatalogNote, IndexRow, List, SequenceRow, Tag } from '@/components/catalog-rows';
import { Clock, Time } from '@/components/clock';
import { ConfirmAction } from '@/components/actions';
import { NodeHead, ReadAlert } from '@/components/node-head';
import { Panel, Rhythm, type Series } from '@/components/panel';
import { Refresh } from '@/components/refresh';
import { redactTree } from '@/components/sql';
import { RowsView } from '@/components/tree-view';
import { catalogFor, scansFor } from '@/lib/catalog';
import { identityFor, readStore } from '@/lib/check';
import { DAY_MS, EVENT_NAMES, HOUR_MS, keepQuery, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { formatBytes, plural } from '@/lib/format';
import { onColumns } from '@/lib/plot';
import { clockFor, treeFor } from '@/lib/samples';
import { shapesFor } from '@/lib/shapes';
import { loadOf } from '@/lib/tree';

/** A size reading stands until the capture after next. */
const SIZE_SPAN_MS = 10 * 60_000;
const SECTION = 'mt-5 mb-2 text-sm/5 font-semibold text-foreground';
const NOTE = 'ml-2.5 text-xs font-normal text-muted-foreground';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string; relation: string }> },
): Promise<Metadata> {
  const { name, relation } = await params;
  return { title: `${name} · ${relation}` };
}

/**
 * One table, with nothing folded, on the clock: its load, its dead rows
 * against the autovacuum trigger, what was written and read, its size, its
 * day by hour; then its statements and their sessions, its indexes and its
 * sequences.
 *
 * It polls, because the sessions on it are live. The catalog is asked about
 * this one table through lib/catalog.ts, at most once a minute however
 * often that is. `relation` arrives already decoded from Next; decoding
 * again would corrupt a name holding a literal percent.
 */
export default async function TablePage({ params, searchParams }: {
  params: Promise<{ name: string; relation: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name, relation }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp, { relation });
  const { grid, read } = clock;
  const catalog = await catalogFor(name, relation);
  const table = catalog.tables[0];
  // A 404 only when the catalog was read and the table is not in it. A read that failed is "could not look".
  if (table === undefined && catalog.at !== null) notFound();

  const to = new Date(grid.to);
  const [known, hours, sizes, rhythm, scans] = await Promise.all([
    shapesFor(name, grid),
    readStore((store) => readTableHours(store, name, relation, new Date(grid.from), to)),
    readStore((store) => readRelationSpace(store, name, relation, new Date(grid.from - SIZE_SPAN_MS), to, { maxPoints: 500 })),
    readStore((store) => readHourly(store, name, 't', relation, new Date(grid.to - 8 * DAY_MS), to)),
    scansFor(name, grid),
  ]);

  const tree = treeFor(clock, { tables: [], tablesTotal: null, shapes: known.shapes, open: new Set([relation]), find: '' });
  const load: Series[] = loadOf(tree.tables.find((t) => t.name === relation)?.strip, tree.seen, grid.columns);
  const hourly = (pick: (h: TableHour) => number): (number | null)[] =>
    onColumns(grid, (hours.ok ? hours.value : []).map((h) => ({ at: h.at, value: pick(h) })), HOUR_MS);
  const size = onColumns(grid, (sizes.ok ? sizes.value : []).map((p) => ({ at: p.capturedAt.getTime(), value: p.sizeBytes })), SIZE_SPAN_MS);
  const events = clock.stored.events.filter((e) => e.at >= grid.from && e.at <= grid.to);
  const marks = (vacuums: boolean) => events
    .filter((e) => (e.kind === 'vacuum') === vacuums && EVENT_NAMES[e.kind] !== undefined)
    .map((e) => ({ at: e.at, label: EVENT_NAMES[e.kind]! }));
  const flags = table === undefined ? [] : tableFlags(table, catalog.freezeMaxAge);
  const canAct = actionsAllowed(process.env);
  // A standby is read-only: ANALYZE fails there, so it is not offered.
  const who = table?.kind === 'table' && grid.live && canAct ? await identityFor(name) : null;
  const standby = who !== null && who.ok && who.data.replica === true;
  const scansOf = (i: (typeof catalog.indexes)[number]): number => (scans.ok ? scans.value.get(i.name) ?? 0 : i.scans);
  /** An empty list is "none" only when it was read. */
  const empty = (read: 'indexes' | 'sequences'): string => (catalog.failed.some((f) => f.read === read) ? 'could not be read' : 'none');

  return (
    <>
      <NodeHead mono title={relation} crumb={[{ label: name, href: `/db/${name}` }, { label: 'Tables', href: `/db/${name}/tables` }]}>
        {table === undefined ? null : (
          <span className="font-mono text-xs text-body tabular-nums">
            {plural(table.liveRows, 'row')} · {formatBytes(table.sizeBytes)}
            {table.lastVacuum === null ? null : <> · vacuumed <Time at={table.lastVacuum} /></>}
          </span>
        )}
        {flags.slice(0, 2).map((f) => <Tag key={f}>{f}</Tag>)}
        {/* The action is the table's, not a moment's: it shows on a live window, pinned or not.
            A plain table only: the action lists nothing else, and would answer "no such table". */}
        {table?.kind === 'table' && grid.live && canAct && !standby ? (
          <span className="ml-auto">
            <ConfirmAction label="Analyze" endpoint={`/api/db/${encodeURIComponent(name)}/analyze`} body={{ relation }} describe="analyze" />
          </span>
        ) : null}
      </NodeHead>
      <ReadAlert read={read} />
      <Clock grid={grid} now={clock.now} day={clock.day} events={clock.events} keep={keepQuery('', null)} initialCursor={clock.pinAt}>
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={5_000} /></div> : null}
        <CatalogNote at={catalog.at} failed={catalog.failed} shown={1} total={null} what="tables" />
        <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Panel wide title="Load" note="sessions not idle" unit="sessions" kind="stack" seen={tree.seen} series={load} marks={marks(false)} />
          {!hours.ok ? (
            <p className="text-xs text-muted-foreground md:col-span-2">
              {hours.kind === 'off' ? 'No store is configured, so this table’s hours are not kept.' : `The store could not be read: ${hours.message}`}
            </p>
          ) : (
            <>
              <Panel
                title="Dead rows" note="against the autovacuum trigger" unit="compact" kind="line" marks={marks(true)}
                series={[{ name: 'Dead rows', tone: 0, values: hourly((h) => h.deadRows) }]}
                limit={{ name: 'Autovacuum trigger', values: hourly((h) => h.vacuumTrigger) }}
              />
              <Panel
                title="Rows written" note="an hour" unit="compact" kind="stack"
                series={[
                  { name: 'Inserted', tone: 0, values: hourly((h) => h.inserted) },
                  { name: 'Updated', tone: 1, values: hourly((h) => h.updated) },
                  { name: 'Deleted', tone: 2, values: hourly((h) => h.deleted) },
                ]}
              />
              <Panel
                title="Rows read" note="an hour" unit="compact" kind="stack"
                series={[
                  { name: 'By index', tone: 0, values: hourly((h) => h.indexRows) },
                  { name: 'By full scan', tone: 2, values: hourly((h) => h.scanRows) },
                ]}
              />
              {sizes.ok
                ? <Panel title="Size" note="on disk, with its indexes" unit="bytes" kind="line" series={[{ name: 'Size', tone: 0, values: size }]} />
                : <p className="text-xs text-muted-foreground md:col-span-2">Its size could not be read: {sizes.message}</p>}
              {rhythm.ok
                ? <Rhythm hours={rhythm.value} />
                : <p className="text-xs text-muted-foreground md:col-span-2">Its rhythm could not be read: {rhythm.message}</p>}
            </>
          )}
        </div>

        <h2 className={SECTION}>Statements<small className={NOTE}>and the sessions running them</small></h2>
        {read !== null && !read.ok ? null : (
          <RowsView database={name} tree={redactTree(tree)} show={{ kind: 'table', name: relation }} actions={canAct} />
        )}

        <h2 className={SECTION}>Indexes</h2>
        {scans.ok || scans.kind === 'off' ? null : (
          <p className="mb-2 text-xs text-muted-foreground">The store could not be read, so scans are since the reset: {scans.message}</p>
        )}
        {catalog.indexes.length === 0 ? <p className="text-muted-foreground">{empty('indexes')}</p> : (
          <List head={['Index', '', 'Size>', scans.ok ? 'Scans, in the window>' : 'Scans, since the reset>', '']}>
            {catalog.indexes.map((i) => (
              <IndexRow key={i.name} database={name} index={i} largest={catalog.indexes[0]!.sizeBytes} scans={scansOf(i)} />
            ))}
          </List>
        )}

        <h2 className={SECTION}>Sequences<small className={NOTE}>against the limit of their type</small></h2>
        {catalog.sequences.length === 0 ? <p className="text-muted-foreground">{empty('sequences')}</p> : (
          <List head={['Sequence', '', '>', '']}>
            {catalog.sequences.map((s) => <SequenceRow key={s.name} sequence={s} />)}
          </List>
        )}
      </Clock>
    </>
  );
}
