import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CHECKS } from '@pgops/checks';
import { Bar, List, TableFactRow } from '@/components/catalog-rows';
import { Clock } from '@/components/clock';
import { ExplainHere } from '@/components/explain-form';
import { NodeHead, ReadAlert } from '@/components/node-head';
import { Panel, type Series } from '@/components/panel';
import { Refresh } from '@/components/refresh';
import { redactTree, safeStatement, Sql } from '@/components/sql';
import { RowsView } from '@/components/tree-view';
import { catalogFor } from '@/lib/catalog';
import { runCheckFor } from '@/lib/check';
import { CLASSES, CLASS_NAMES, keepQuery, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { formatMillis, formatRate } from '@/lib/format';
import { clockFor, treeFor } from '@/lib/samples';
import { unseenAt } from '@/lib/tree';
import { shapeFor } from '@/lib/shapes';

/** Every lasting session of one statement; the tree lists three and sends the reader here for the rest. */
const SESSIONS_ALL = 200;
/** Past this the head has cut the statement, so it follows once, whole. */
const HEAD_FITS = 90;
const SECTION = 'mt-5 mb-2 text-sm/5 font-semibold text-foreground';
const NOTE = 'ml-2.5 text-xs font-normal text-muted-foreground';

export async function generateMetadata(
  { params }: { params: Promise<{ name: string; queryid: string }> },
): Promise<Metadata> {
  const { name, queryid } = await params;
  return { title: `${name} · statement ${queryid}` };
}

/** One figure of the stat line: an 11 px label, an 18 px value, and a meter where the value is a ratio. */
function Stat({ label, value, share }: { label: string; value: string; share?: number | null }) {
  return (
    <div data-stat>
      <small className="block text-[11px]/4 tracking-[0.05em] text-muted-foreground uppercase">{label}</small>
      <b className="font-mono text-lg/6 font-medium text-foreground tabular-nums">{value}</b>
      {share === undefined || share === null ? null : <Bar share={share} className="mt-1 w-[90px] min-w-0" />}
    </div>
  );
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

/**
 * One statement, on the clock: its numbers over the window, its load split
 * by class, the tables it is on and every session that has been running it
 * for thirty seconds. Explain, in the head, opens its generic plan in place.
 *
 * The numbers are the window's, from the stored snapshots. Where the store
 * holds no window for it they are the live counters since the statistics
 * were reset, which the page says, and a rate is not claimed. This is one
 * of the two pages that read `queryStats`; it asks for this shape alone.
 */
export default async function StatementPage({ params, searchParams }: {
  params: Promise<{ name: string; queryid: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name, queryid }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp);
  const { grid, read } = clock;
  const [known, live, catalog] = await Promise.all([
    shapeFor(name, grid, queryid),
    runCheckFor(name, CHECKS.queryStats, { sort: 'total', limit: 1, queryid }),
    catalogFor(name),
  ]);
  const { shape } = known;
  const row = live.ok ? live.data.rows[0] : undefined;

  const tree = treeFor(clock, {
    tables: [], tablesTotal: null, shapes: shape === null ? [] : [shape],
    open: new Set(), find: '', only: queryid, sessionsMax: SESSIONS_ALL,
  });
  const node = tree.flat[0];
  // An id nothing knows: not sampled, not in a snapshot, not in pg_stat_statements. Only when that last was read.
  if (node === undefined && shape === null && live.ok && row === undefined) notFound();

  const raw = shape?.text ?? clock.statements.get(queryid)?.text ?? (row === undefined || row.redacted ? null : row.query);
  const text = raw === null || raw === undefined ? null : safeStatement(raw);
  const strip = node?.strip ?? Array.from({ length: grid.columns }, () => [0, 0, 0, 0, 0]);
  const load: Series[] = CLASSES.map((c, i) => ({ name: CLASS_NAMES[c], tone: c, values: strip.map((col, k) => (unseenAt(tree.seen, k) ? null : col[i] ?? 0)) }));
  const on = (node?.tables ?? shape?.relations ?? []).filter((t) => t !== '');
  // No plan has placed it yet, which is not the same as a plan that names no table.
  const unplaced = node === undefined ? shape?.relations == null : node.unplaced;

  const mean = shape?.meanMs ?? row?.meanMs ?? null;
  const rowsPerCall = shape?.rowsPerCall ?? (row === undefined || row.calls === 0 ? null : row.rows / row.calls);
  const hit = shape !== null ? shape.cacheHit : row === undefined || row.cacheHitPct === null ? null : row.cacheHitPct / 100;
  const share = shape !== null && known.allMs !== null && known.allMs > 0 ? shape.totalMs / known.allMs
    : row !== undefined && live.ok && live.data.allMs > 0 ? row.totalMs / live.data.allMs : null;
  const canAct = actionsAllowed(process.env);

  return (
    <>
      <NodeHead
        mono
        title={text === null ? `statement ${queryid}` : <Sql>{text}</Sql>}
        crumb={[{ label: name, href: `/db/${name}` }, { label: 'Queries', href: `/db/${name}/queries` }]}
      >
        {text === null ? null : <ExplainHere name={name} statement={safeStatement(text)} />}
      </NodeHead>
      {text !== null && text.length > HEAD_FITS ? (
        <div className="mb-3 rounded-md border bg-card px-3 py-2"><Sql whole>{text}</Sql></div>
      ) : null}
      <div className="flex flex-wrap gap-x-7 gap-y-3 pt-1 pb-3.5">
        <Stat label="calls / s" value={shape === null ? '—' : formatRate(shape.callsPerSec)} />
        <Stat label="mean" value={formatMillis(mean)} />
        <Stat label="rows / call" value={rowsPerCall === null ? '—' : rowsPerCall.toFixed(1)} />
        <Stat label="cache hit" value={pct(hit)} share={hit} />
        <Stat label="share of time" value={pct(share)} share={share} />
      </div>
      {shape === null && row !== undefined ? (
        <p className="pb-2 text-xs text-muted-foreground">since the statistics were reset: the store holds no window for this statement</p>
      ) : null}
      <ReadAlert read={read} />
      <Clock grid={grid} now={clock.now} day={clock.day} events={clock.events} keep={keepQuery('', null)} initialCursor={clock.pinAt}>
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={5_000} /></div> : null}
        <div className="mb-4 grid grid-cols-1 gap-3">
          <Panel title="Load" note="sessions not idle" unit="sessions" kind="stack" series={load} />
        </div>

        <h2 className={SECTION}>Tables<small className={NOTE}>this statement reads or writes</small></h2>
        {on.length === 0 ? <p className="text-muted-foreground">{unplaced ? 'not placed' : 'on no table'}</p> : (
          <List head={['Table', 'Rows>', 'Size>', 'Dead rows, against the trigger', 'Vacuumed>', '']}>
            {on.map((t) => {
              const fact = catalog.tables.find((x) => x.name === t);
              // A table past the catalog's cap, or dropped since: its name, and nothing claimed about it.
              return fact === undefined
                ? <tr key={t}><td colSpan={6} className="border-t px-3 py-[5px] font-mono text-muted-foreground">{t}</td></tr>
                : <TableFactRow key={t} database={name} table={fact} freezeMaxAge={catalog.freezeMaxAge} />;
            })}
          </List>
        )}

        <h2 className={SECTION}>Sessions<small className={NOTE}>running it, longer than 30 s</small></h2>
        {read !== null && !read.ok ? null : (
          <RowsView database={name} tree={redactTree(tree)} show={{ kind: 'sessions', key: queryid }} actions={canAct} />
        )}
      </Clock>
    </>
  );
}
