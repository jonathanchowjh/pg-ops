import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ConfigErrorPage } from '@/components/config-error';
import { Clock } from '@/components/clock';
import { FleetView } from '@/components/fleet-view';
import { NodeHead } from '@/components/node-head';
import { Refresh } from '@/components/refresh';
import { DAY_MS, downSince, gridFor, type Search } from '@/lib/clock';
import { ConfigError } from '@/lib/config';
import { plural } from '@/lib/format';
import { databaseNames } from '@/lib/pools';
import { MEMORY_MS, dayColumns, dayEnd, fleetRowFor, kept, type FleetRow } from '@/lib/samples';

export const metadata: Metadata = { title: 'Fleet' };

/**
 * The fleet: one row per database on the clock, from the store or this
 * process's memory. It contacts no database, so a stopped one costs the
 * others nothing, and it polls at the sample cadence: a faster poll would
 * read the same rows.
 */
export default async function Fleet({ searchParams }: { searchParams: Promise<Search> }) {
  // `databaseNames()` reads `process.env` and has no `connection()` gate of its own.
  await connection();
  const sp = await searchParams;
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }
  // With no store the clock holds fifteen minutes, so that is the window it opens on.
  const asked = sp.win === undefined && kept() === 'memory' ? { ...sp, win: String(MEMORY_MS / 1000) } : sp;
  const now = Date.now();
  const grid = gridFor(asked, now);
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
      </NodeHead>
      <Clock grid={grid} now={now} day={{ to: dayTo, columns: day }} events={events}>
        {grid.live ? <div className="flex justify-end pt-1.5"><Refresh intervalMs={15_000} /></div> : null}
        {rows.length === 0 ? <p className="my-3 text-muted-foreground">No database is configured.</p> : <FleetView rows={rows} />}
      </Clock>
    </main>
  );
}
