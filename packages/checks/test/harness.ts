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
 * The container is started once per run by `global-setup.ts`. Every call
 * gets its own CREATE DATABASE, so tests never see each other's fixtures,
 * and drops it once `fn` settles: an abandoned database would pollute any
 * check that scans every database on the server (e.g. wraparound).
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
    // `.catch`: a rejecting `end()` would throw out of this `finally` after
    // CREATE DATABASE succeeded, skip the DROP below and leak the database
    // into the shared container.
    await admin.end().catch(() => {});
  }

  const uri = new URL(baseUri);
  uri.pathname = `/${dbName}`;
  // No application_name: this one pool is both `ctx.target` and the fixture
  // connection standing in for the monitored application. The
  // activity/horizon checks exclude backends sharing the checking
  // connection's application_name, so naming the pool would make them
  // exclude the load the tests exist to observe. Unnamed, only
  // pid <> pg_backend_pid() excludes the checking backend, unless a test
  // sets application_name itself.
  const pool = new Pool({ connectionString: uri.toString(), max: 4 });

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
    // so the test pool closes before the drop below.
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
 * Polls until the server has published a statistic — a fixture precondition,
 * never the thing under test. `sql` returns one row with one boolean column
 * named `ready`.
 *
 * Since PostgreSQL 15 a backend accumulates statistics locally and flushes
 * them at transaction end, and only once PGSTAT_MIN_INTERVAL has elapsed, so
 * a pool spreading work across four backends publishes nothing for seconds.
 * (psql publishes at once because a disconnecting backend flushes.)
 *
 * Do not use `pg_stat_force_next_flush()` instead: it does not exist before
 * 15 and the gate matrix runs 14.
 */
export async function awaitPublished(
  pool: pg.Pool,
  what: string,
  sql: string,
  values: unknown[] = [],
): Promise<void> {
  // Half the integration test timeout. 20s was not enough on a loaded machine:
  // an idle backend holding pending statistics flushes them only when it next
  // runs something.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await pool.query<{ ready: boolean | null }>(sql, values);
    if (rows[0]?.ready === true) return;
    if (Date.now() > deadline) throw new Error(`${what} not published within 60s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
