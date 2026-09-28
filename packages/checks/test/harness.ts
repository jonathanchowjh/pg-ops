import pg from 'pg';
import { inject } from 'vitest';
import type { CheckContext } from '../src/types.js';

declare module 'vitest' {
  interface ProvidedContext {
    /** Admin connection URI for the one Postgres container `global-setup.ts` starts per run. */
    pgConnectionUri: string;
  }
}

const { Pool } = pg;

/**
 * Run `fn` against a live Postgres with a fresh, isolated database.
 *
 * The container is started once per run by `global-setup.ts`, not here —
 * see that file for why module-scope state in a test file can't provide
 * that guarantee. Every call still gets its own CREATE DATABASE, so tests
 * never observe each other's fixtures, and every call DROPs that database
 * once `fn` settles: with one container now serving every integration file,
 * an abandoned database would silently sit in `pg_database` and pollute any
 * check that scans across every database on the server (e.g. Task 7's
 * wraparound check).
 */
export async function withPostgres(
  fn: (ctx: CheckContext, pool: pg.Pool) => Promise<void>,
): Promise<void> {
  const baseUri = inject('pgConnectionUri');
  const dbName = `t_${Math.random().toString(36).slice(2, 10)}`;

  const admin = new Pool({ connectionString: baseUri, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    // M3: `.catch(() => {})`, matching the two sibling `end()` calls below.
    // Without it, a `Pool.end()` that rejects (pg rejects on a double-end,
    // or on a client error during graceful shutdown) throws out of this
    // `finally` AFTER `CREATE DATABASE` has already succeeded — and the
    // cleanup block that would `DROP DATABASE` sits past this try/finally
    // and never runs. The just-created database then leaks into the one
    // container every integration file now shares, where `wraparound`'s
    // `FROM pg_database` scan will see it. Low probability; the failure is
    // a leaked database, not merely a masked error.
    await admin.end().catch(() => {});
  }

  const uri = new URL(baseUri);
  uri.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: uri.toString(), max: 4, application_name: 'pgops-test' });

  let hadError = false;
  let testError: unknown;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
    const { rows } = await pool.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    await fn({ target: pool, serverVersion: Number(rows[0]!.v) }, pool);
  } catch (err) {
    hadError = true;
    testError = err;
  } finally {
    // Postgres refuses to DROP a database with a live connection against it,
    // so the test pool must close before the drop below — and the drop needs
    // its own admin connection, since this one is closing.
    await pool.end().catch(() => {});
  }

  const cleanup = new Pool({ connectionString: baseUri, max: 1 });
  try {
    // Drop even when `fn` threw — a failed test must not leak a database.
    await cleanup.query(`DROP DATABASE IF EXISTS ${dbName}`);
  } catch (dropErr) {
    // A cleanup failure must never replace or hide the test's own outcome.
    console.error(`withPostgres: failed to drop database ${dbName}`, dropErr);
  } finally {
    await cleanup.end().catch(() => {});
  }

  if (hadError) throw testError;
}

/** Run setup SQL, one statement per call. Keeps failures attributable. */
export async function seed(pool: pg.Pool, sql: string): Promise<void> {
  await pool.query(sql);
}

/**
 * Polls until the server has PUBLISHED a statistic, which is a fixture
 * precondition and never the thing under test. `sql` returns one row with one
 * boolean column named `ready`.
 *
 * Since PostgreSQL 15 a backend accumulates statistics locally and flushes
 * them to shared memory at transaction end, and only once PGSTAT_MIN_INTERVAL
 * has elapsed — so a pool spreading work across four backends publishes
 * nothing for seconds. Every fixture that needed this was written without a
 * poll first and failed: a real table hit rate read null, `seq_scan` after
 * CREATE INDEX read 0, and `n_dead_tup` after deleting 400 rows read 0. The
 * same commands run through `psql` publish immediately, because each psql
 * invocation disconnects and a disconnecting backend flushes.
 *
 * `pg_stat_force_next_flush()` would remove the wait outright but does not
 * exist before 15, and the gate matrix runs 14 — the floor this project
 * declares. So: poll, with a ceiling that fails loudly rather than hanging
 * the suite.
 *
 * IT LIVES HERE BECAUSE THE ALTERNATIVE WAS TRIED. This was a local function
 * in tables.int.test.ts, indexes.int.test.ts grew two specialised copies of
 * the same loop, and table-list.int.test.ts — written later, against a gate
 * run that used the default single version — reached for
 * `pg_stat_force_next_flush()` instead and failed on the 14 leg. The two
 * docblocks that already knew the function was unusable were in files its
 * author had no reason to open. A shared export is findable from the harness
 * every integration file already imports.
 */
export async function awaitPublished(
  pool: pg.Pool,
  what: string,
  sql: string,
  values: unknown[] = [],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { rows } = await pool.query<{ ready: boolean | null }>(sql, values);
    if (rows[0]?.ready === true) return;
    if (Date.now() > deadline) throw new Error(`${what} not published within 20s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
