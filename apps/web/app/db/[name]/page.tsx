import type { Metadata } from 'next';
import { CHECKS, grantRemedy } from '@pgops/checks';
import { Clock } from '@/components/clock';
import { FindBox, NodeHead, ReadAlert } from '@/components/node-head';
import { Refresh } from '@/components/refresh';
import { redactTree } from '@/components/sql';
import { TreeView } from '@/components/tree-view';
import { catalogFor, pointersOf, tablesFor } from '@/lib/catalog';
import { runCheckFor } from '@/lib/check';
import { keepQuery, one, openFrom, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { clockFor, healthFor, liveMinute, treeFor } from '@/lib/samples';
import { shapesFor } from '@/lib/shapes';

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: name };
}

/**
 * The database's page is the tree, on the clock.
 *
 * A live window reads the sessions once; a window in the past reads the
 * store and no database. The catalog comes through lib/catalog.ts, which
 * reads at most once a minute.
 */
export default async function DatabasePage({ params, searchParams }: {
  params: Promise<{ name: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ name }, sp] = await Promise.all([params, searchParams]);
  const clock = await clockFor(name, sp);
  const { grid, read } = clock;
  const find = one(sp.find);
  const open = openFrom(sp.open);

  // In this order: the second is served from the first's read.
  const catalog = await catalogFor(name);
  const tables = await tablesFor(name, find);
  const [known, lag, xid, connections, health] = await Promise.all([
    shapesFor(name, grid),
    grid.live ? runCheckFor(name, CHECKS.replicationLag) : null,
    grid.live ? runCheckFor(name, CHECKS.wraparound) : null,
    grid.live ? runCheckFor(name, CHECKS.connections) : null,
    healthFor(name, grid),
  ]);

  // The live reads are the newest minute of the health row, at the live cursor.
  const minutes = [...(health.ok ? health.value : []), ...(grid.live ? [liveMinute(grid.to - 1, lag, xid, connections)] : [])];
  const tree = treeFor(clock, { tables: tables.facts, tablesTotal: tables.total, shapes: known.shapes, open, find, health: minutes });

  return (
    <>
      <NodeHead title={name} crumb={[{ label: 'Fleet', href: '/' }]}>
        <FindBox find={find} label="find a table, a statement or a pid" winSecs={grid.winSecs} end={grid.live ? null : grid.to} />
      </NodeHead>
      <ReadAlert read={read} />
      <Clock
        grid={grid} now={clock.now} day={clock.day} events={clock.events}
        keep={keepQuery(find, open === null ? null : [...open])} initialCursor={clock.pinAt}
      >
        {/* Under the clock, not in the head: it holds while the clock is pinned, and reads that from context. */}
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={5_000} /></div> : null}
        {read !== null && !read.ok ? null : (
          <TreeView
            database={name}
            tree={redactTree(tree)}
            find={find}
            pointers={grid.live ? pointersOf(name, catalog) : []}
            catalog={{ at: catalog.at, failed: catalog.failed[0]?.message ?? null }}
            grant={grantRemedy('pg_read_all_stats')}
            kept={clock.stored.kept}
            storeFailed={clock.stored.failed}
            actions={actionsAllowed(process.env)}
          />
        )}
      </Clock>
    </>
  );
}
