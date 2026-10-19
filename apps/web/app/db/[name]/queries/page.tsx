import type { Metadata } from 'next';
import Link from 'next/link';
import { CHECKS, SLOW_QUERY_DEFAULTS } from '@pgops/checks';
import { Clock } from '@/components/clock';
import { FindBox, NodeHead, ReadAlert } from '@/components/node-head';
import { Refresh } from '@/components/refresh';
import { Scatter } from '@/components/scatter';
import { redactTree, safeStatement } from '@/components/sql';
import { RowsView } from '@/components/tree-view';
import { runCheckFor } from '@/lib/check';
import { keepQuery, one, openFrom, windowQuery, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { formatCount, formatMillis, formatRate } from '@/lib/format';
import type { Mark } from '@/lib/plot';
import { clockFor, treeFor } from '@/lib/samples';
import { shapesFor } from '@/lib/shapes';

/** The hottest statements listed, and how many the fold opens to. */
const HOT = 20;
const ALL = 200;
/** The fold's key in `?open=`. */
const REST = 'rest';
/** Shapes read live: the population when the store holds no window. */
const LIVE_SHAPES = 200;

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: `${name} · Queries` };
}

/** A statement as a label on a plot: one line, redacted, then cut. */
const clip = (text: string): string => {
  const safe = safeStatement(text);
  return safe.length > 28 ? `${safe.slice(0, 27)}…` : safe;
};

/**
 * The Queries population: which of many statements matter. Calls a second
 * against mean time over the window, a dashed line of equal cost, a slow and
 * busy statement flagged; then the hottest rows on the clock, the rest
 * behind one fold.
 *
 * The window's numbers are the stored snapshots. `queryStats` is the one
 * live read of `pg_stat_statements` and is the population when the store
 * holds no window, measured since the statistics were reset, which the page
 * then says.
 */
export default async function Queries({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp);
  const { grid, read } = clock;
  const find = one(sp.find);
  const open = openFrom(sp.open);
  const rest = open?.has(REST) ?? false;
  const [known, live] = await Promise.all([
    shapesFor(name, grid),
    runCheckFor(name, CHECKS.queryStats, { sort: 'total', limit: LIVE_SHAPES }),
  ]);

  const tree = treeFor(clock, {
    tables: [], tablesTotal: null, shapes: known.shapes, open: new Set(), find, flat: rest ? ALL : HOT,
  });

  const page = (id: string): string => `/db/${name}/queries/${encodeURIComponent(id)}`;
  const point = (id: string, text: string, rate: number, mean: number, calls: number, share: number | null): Mark => ({
    id, label: clip(text), x: rate, y: mean, weight: rate * mean, href: page(id),
    flag: mean >= SLOW_QUERY_DEFAULTS.minMeanMs && calls >= SLOW_QUERY_DEFAULTS.minCalls,
    lines: [
      `${formatRate(rate)} calls a second`, `${formatMillis(mean)} mean`,
      ...(share === null ? [] : [`${(share * 100).toFixed(1)}% of the time`]),
    ],
  });
  const windowed = known.shapes.map((s) =>
    point(s.key, s.text, s.callsPerSec, s.meanMs, s.calls, known.allMs === null || known.allMs <= 0 ? null : s.totalMs / known.allMs));
  // Since the reset: the only interval a live counter has.
  const since = live.ok && live.data.statsResetAt !== null ? (clock.now - Date.parse(live.data.statsResetAt)) / 1000 : null;
  const lifetime = !live.ok || since === null || !(since > 0) ? [] : live.data.rows.flatMap((r) => (
    r.redacted || r.queryid === null || r.query === null || r.calls <= 0 ? []
      : [point(r.queryid, r.query, r.calls / since, r.meanMs, r.calls, live.data.allMs > 0 ? r.totalMs / live.data.allMs : null)]
  ));
  const marks = windowed.length > 0 ? windowed : lifetime;
  const here = windowQuery(grid.winSecs, grid.live ? null : grid.to);

  return (
    <>
      <NodeHead title="Queries" crumb={[{ label: name, href: `/db/${name}` }]}>
        {live.ok ? <span className="font-mono text-xs text-body tabular-nums">{formatCount(live.data.totalShapes)} shapes</span> : null}
        <FindBox find={find} label="find a statement" winSecs={grid.winSecs} end={grid.live ? null : grid.to} />
        <Link href={`/db/${name}/explain`} className="rounded-[5px] border bg-card px-2 py-0.5 text-xs/[18px] text-foreground hover:bg-muted">
          Explain a statement
        </Link>
      </NodeHead>
      <ReadAlert read={read} />
      <Clock
        grid={grid} now={clock.now} day={clock.day} events={clock.events}
        keep={keepQuery(find, open === null ? null : [...open])} initialCursor={clock.pinAt}
      >
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={5_000} /></div> : null}
        <section className="my-3 rounded-md border bg-card">
          <h2 className="px-3 pt-2 text-[13px]/[18px] font-semibold text-foreground">
            Every statement
            <small className="ml-1.5 font-normal text-muted-foreground">
              up and to the right costs more; a dashed line is equal cost
              {windowed.length === 0 && lifetime.length > 0 ? '; since the statistics were reset' : ''}
            </small>
          </h2>
          {live.ok || marks.length > 0 ? (
            <Scatter
              marks={marks}
              x={{ label: 'calls a second', unit: 'rate' }} y={{ label: 'mean time', unit: 'millis' }}
              iso={[
                { product: 10, label: '0.01 not idle' }, { product: 100, label: '0.1 not idle' }, { product: 1000, label: '1 session not idle' },
              ]}
            />
          ) : (
            <p className="px-3 py-3 text-muted-foreground">
              The statement statistics could not be read: {live.message}
              {live.remedy === undefined ? null : <code className="ml-2 font-mono text-foreground">{live.remedy}</code>}
            </p>
          )}
        </section>
        {read !== null && !read.ok ? null : (
          <RowsView
            database={name} tree={redactTree(tree)} show={{ kind: 'statements' }} actions={actionsAllowed(process.env)}
            moreHref={`${here}${keepQuery(find, [REST])}`}
          />
        )}
      </Clock>
    </>
  );
}
