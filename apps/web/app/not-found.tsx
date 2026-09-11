import Link from 'next/link';
import { connection } from 'next/server';
import { databaseNames } from '@/lib/pools';
import { ConfigError } from '@/lib/config';

/**
 * The 404, which was Next's stock "This page could not be found" — a bare
 * page with no way back, no indication it belonged to pgops, and, worst of
 * the three, no answer to the only question its reader has.
 *
 * `app/db/[name]/layout.tsx` reaches this deliberately: an unconfigured name
 * is a 404 and not a 500 because, in that file's own words, "the operator
 * mistyped, pgops is not broken". But knowing you mistyped is not the same as
 * knowing what the right spelling was, and the console is the only thing that
 * knows — the names are whatever the operator put in `PGOPS_DATABASES`, and
 * they are one `databaseNames()` call away. Listing them turns a dead end
 * into the correction.
 *
 * Reads configuration, so it is dynamic like every other such route (see the
 * plan's Global Constraints on `connection()`).
 */
export default async function NotFound() {
  await connection();

  // This page must render even when it is the CONFIGURATION that is broken —
  // it is reached by any unmatched URL, including on a misconfigured console,
  // and a 404 that itself 500s is the least helpful page in the product.
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
