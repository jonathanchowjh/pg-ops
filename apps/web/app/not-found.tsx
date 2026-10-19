import Link from 'next/link';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';

/**
 * The 404. `app/db/[name]/layout.tsx` sends an unconfigured database name
 * here, so the page lists the configured names: the likely cause is a typo.
 *
 * Reads configuration, so it awaits `connection()` to be dynamic.
 */
export default async function NotFound() {
  await connection();

  // Reached by any unmatched URL, including on a misconfigured console, so
  // it must render when the configuration is broken.
  let names: string[] = [];
  let configBroken: string | null = null;
  try {
    names = databaseNames();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    configBroken = err.message;
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-2 text-xl font-semibold">No such page</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        pgops is running. This URL does not name anything it serves — most often a database name
        that is not in this console&apos;s configuration, or a typo in a route.
      </p>

      {configBroken ? (
        <div className="rounded-lg border border-l-4 border-l-warning p-4 text-sm">
          <p className="mb-2 font-medium">pgops also cannot read its own configuration.</p>
          <p className="text-muted-foreground">{configBroken}</p>
        </div>
      ) : (
        <div className="rounded-lg border p-4 text-sm">
          <h2 className="mb-3 font-medium">
            {names.length === 1 ? 'The one database this console is configured for' : 'Databases this console is configured for'}
          </h2>
          <ul className="grid gap-2">
            {names.map((n) => (
              <li key={n}>
                <Link href={`/db/${n}`} className="font-medium underline underline-offset-4">
                  {n}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-4 text-sm">
        <Link href="/" className="underline underline-offset-4">
          ← All databases
        </Link>
      </p>
    </main>
  );
}
