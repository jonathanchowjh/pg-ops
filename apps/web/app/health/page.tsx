import Link from 'next/link';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';
import { ConfigErrorPage } from '@/components/config-error';
import { HealthChart } from '@/components/health-chart';
import { Refresh } from '@/components/refresh';
import {
  FLEET_HOURS, FLEET_POINTS, HEALTH_CHARTS, chartFor, emptyReason, healthFor,
} from '@/lib/health';

const FLEET = HEALTH_CHARTS.filter((c) => c.fleet);

/**
 * Every database, six charts, last 48 hours. The shift check: did anything
 * get worse since yesterday.
 *
 * Reads the store and nothing else, so it costs the monitored databases
 * nothing to leave open, and a database that is down still shows its past.
 */
export default async function FleetHealth() {
  await connection();
  let names: string[];
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return <ConfigErrorPage message={err.message} />;
  }
  const to = new Date();
  const from = new Date(to.getTime() - FLEET_HOURS * 3_600_000);
  const read = await healthFor(names, from, to, FLEET_POINTS);

  return (
    <main className="mx-auto w-full max-w-[84rem] px-6 pt-6 pb-40">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← All databases
          </Link>
          <h1 className="mt-1 text-xl font-semibold">Health</h1>
          <p className="text-sm text-muted-foreground">
            Last {FLEET_HOURS} hours. A break in a line is time pgops did not record.
          </p>
        </div>
        {/* One row a minute is captured; redrawing faster shows the same rows. */}
        <Refresh intervalMs={60_000} />
      </header>

      {!read.ok ? (
        <p role={read.kind === 'error' ? 'alert' : undefined} className="text-sm">{read.message}</p>
      ) : read.histories.map((h) => (
        <section key={h.name} className="border-t py-4">
          <h2 className="mb-2 font-semibold">
            <Link href={`/db/${h.name}/health`} className="underline-offset-4 hover:underline">{h.name}</Link>
          </h2>
          {h.rows < 2 ? (
            <p className="text-sm text-muted-foreground">
              {emptyReason(h.lastAt, to.getTime(), to.getTime())}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3 xl:grid-cols-6">
              {FLEET.map((spec) => {
                const c = chartFor(spec, h.points);
                return (
                  <HealthChart
                    key={c.metric} compact label={c.label} unit={c.unit} points={c.points}
                    from={from.getTime()} to={to.getTime()} ceiling={c.ceiling} zero={c.zero} empty={c.empty}
                  />
                );
              })}
            </div>
          )}
        </section>
      ))}
    </main>
  );
}
