import type { Metadata } from 'next';
import { CHECKS, grantRemedy, type CheckResult } from '@pgops/checks';
import { Clock } from '@/components/clock';
import { FindBox, NodeHead, ReadAlert } from '@/components/node-head';
import { Refresh } from '@/components/refresh';
import { redactTree } from '@/components/sql';
import { TreeView } from '@/components/tree-view';
import { catalogFor, pointersOf, tablesFor } from '@/lib/catalog';
import { runCheckFor } from '@/lib/check';
import { keepQuery, one, openFrom, type Search } from '@/lib/clock';
import { actionsAllowed } from '@/lib/config';
import { clockFor, treeFor } from '@/lib/samples';
import { shapesFor } from '@/lib/shapes';
import type { Pointer } from '@/lib/tree';

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const { name } = await params;
  return { title: name };
}

/** A Server read that crossed a mark, as a line for the top of the tree. */
function serverFinding(label: string, href: string, r: CheckResult<unknown> | null): Pointer[] {
  if (r === null || !r.ok || r.verdict === null || r.verdict.level === 'ok') return [];
  return [{ label, note: r.verdict.note ?? '', level: r.verdict.level, href }];
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
  const cleanup = `/db/${name}/cleanup`;

  // In this order: the second is served from the first's read.
  const catalog = await catalogFor(name);
  const tables = await tablesFor(name, find);
  const [known, lag, xid, connections] = await Promise.all([
    shapesFor(name, grid),
    grid.live ? runCheckFor(name, CHECKS.replicationLag) : null,
    grid.live ? runCheckFor(name, CHECKS.wraparound) : null,
    grid.live ? runCheckFor(name, CHECKS.connections) : null,
  ]);

  const tree = treeFor(clock, { tables: tables.facts, tablesTotal: tables.total, shapes: known.shapes, open, find });

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
            pointers={[
              ...serverFinding('replication', cleanup, lag),
              ...serverFinding('transaction ID age', cleanup, xid),
              ...serverFinding('connections', `/db/${name}/health`, connections),
              // Catalog findings exist at live only.
              ...(grid.live ? pointersOf(name, catalog) : []),
            ]}
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
