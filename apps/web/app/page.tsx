import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ConfigErrorPage } from '@/components/config-error';
import { Clock } from '@/components/clock';
import { Databases } from '@/components/databases';
import { FleetView } from '@/components/fleet-view';
import { NodeHead } from '@/components/node-head';
import { Refresh } from '@/components/refresh';
import { DAY_MS, downSince, gridFor, type Search } from '@/lib/clock';
import { ConfigError, actionsAllowed, savedPath } from '@/lib/config';
import { plural } from '@/lib/format';
import { databaseList } from '@/lib/pools';
import { asked, dayColumns, dayEnd, fleetRowFor, type FleetRow } from '@/lib/samples';

export const metadata: Metadata = { title: 'Fleet' };

/**
 * The fleet: one row per database on the clock, from the store or this
 * process's memory. It contacts no database, so a stopped one costs the
 * others nothing, and it polls at the sample cadence: a faster poll would
 * read the same rows.
 */
export default async function Fleet({ searchParams }: { searchParams: Promise<Search> }) {
  // `databaseList()` reads `process.env` and has no `connection()` gate of its own.
  await connection();
  const sp = await searchParams;
  let list: ReturnType<typeof databaseList>;
  try {
    list = databaseList();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }
  const databases = <Databases databases={list} actionsOn={actionsAllowed(process.env)} savedTo={savedPath(process.env)} />;
  if (list.length === 0) {
    return (
      <main className="mx-auto w-full max-w-[84rem] min-w-0 px-4 pb-16 text-[13px]/5 md:px-5">
        <NodeHead title="Fleet" crumb={[]} />
        <div className="my-6 max-w-xl space-y-3 rounded-lg border p-5">
          <p className="font-medium">No database is connected yet.</p>
          <p className="text-muted-foreground">
            Add one here: pgops tests the connection, shows you that its session is read only, and saves it.
            Or set <code className="font-mono text-xs">DATABASE_URL</code> or <code className="font-mono text-xs">PGOPS_DATABASES</code>.
          </p>
          {databases}
        </div>
      </main>
    );
  }
  const names = list.map((d) => d.name);
  const now = Date.now();
  const grid = gridFor(asked(sp), now);
  const read = await Promise.all(names.map((name) => fleetRowFor(name, grid)));

  // Rows keep the operator's configured order, which they know by position.
  const rows: FleetRow[] = read.map((r) => r.row);
  const day = read.reduce<[number, number][]>((into, r) => dayColumns(r.day, into), dayColumns([]));
  const dayTo = dayEnd(now);
  const seen = new Set<string>();
  const events = read.flatMap((r) => r.events)
    .filter((e) => e.at >= dayTo - DAY_MS && !seen.has(`${e.at}/${e.kind}/${e.relation}`) && seen.add(`${e.at}/${e.kind}/${e.relation}`) !== null)
    .sort((a, b) => a.at - b.at);
  const down = rows.filter((r) => downSince(r.transitions, now) !== null).length;

  return (
    <main className="mx-auto w-full max-w-[84rem] min-w-0 px-4 pb-16 text-[13px]/5 md:px-5">
      <NodeHead title="Fleet" crumb={[]}>
        <span className="font-mono text-xs text-body tabular-nums">
          {plural(rows.length, 'database')}{down > 0 ? ` · ${down} unreachable` : ''}
        </span>
        {databases}
      </NodeHead>
      <Clock grid={grid} now={now} day={{ to: dayTo, columns: day }} events={events}>
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={15_000} /></div> : null}
        <FleetView rows={rows} />
      </Clock>
    </main>
  );
}
