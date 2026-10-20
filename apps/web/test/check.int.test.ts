import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from '@pgops/checks';
import { IMAGE } from './harness';

let pg: StartedPostgreSqlContainer;

beforeAll(async () => {
  pg = await new PostgreSqlContainer(IMAGE).start();
  process.env.PGOPS_DATABASES = JSON.stringify([{ name: 'primary', url: pg.getConnectionUri() }]);
}, 120_000);

afterAll(async () => { await pg?.stop(); });

describe('runCheckFor', () => {
  it('runs a check against the named database and reports ok', async () => {
    const { runCheckFor } = await import('../lib/check.js');
    const r = await runCheckFor('primary', CHECKS.connections);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.max).toBeGreaterThan(0);
  });

  /**
   * A hardcoded version would make every version-gated check appear supported
   * on a server that does not support it.
   */
  it('probes the real server version into the context', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const ctx = await contextFor('primary');
    expect(ctx.serverVersion).toBeGreaterThanOrEqual(140000);
    const { rows } = await ctx.target.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(ctx.serverVersion).toBe(Number(rows[0]!.server_version_num));
  });

  /** A pool per request would exhaust max_connections on the database being diagnosed. */
  it('reuses one pool across calls for the same database', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const a = await contextFor('primary');
    const b = await contextFor('primary');
    expect(a.target).toBe(b.target);
  });

  it('throws UnknownDatabaseError for a name that is not configured', async () => {
    const { contextFor, UnknownDatabaseError } = await import('../lib/pools.js');
    await expect(contextFor('nope')).rejects.toThrow(UnknownDatabaseError);
  });

  /** A page renders a failed check; it must never render a stack trace. */
  it('returns ok:false rather than rejecting when a check cannot run', async () => {
    const { runCheckFor } = await import('../lib/check.js');
    const broken = { ...CHECKS.connections, sql: 'SELECT * FROM does_not_exist' };
    const r = await runCheckFor('primary', broken);
    expect(r.ok).toBe(false);
  });
});

/**
 * A table page 404s only when the catalog was read without the table in it.
 * A migration's lock fails the read, so the page must say it could not look.
 */
describe('catalogFor', () => {
  it('reads a table a migration holds as could not be read, never as missing', async () => {
    const { Client } = await import('pg');
    const { catalogFor } = await import('../lib/catalog.js');
    const holder = new Client({ connectionString: pg.getConnectionUri() });
    await holder.connect();
    try {
      await holder.query('CREATE TABLE IF NOT EXISTS migrating (id int)');
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE migrating IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      const c = await catalogFor('primary', 'public.migrating');
      expect(Date.now() - started).toBeLessThan(5_000);
      // What the page decides on: no table, and no reading, so not a 404.
      expect(c.tables).toEqual([]);
      expect(c.at).toBeNull();
      expect(c.failed).toEqual([{ read: 'tables', message: expect.stringMatching(/lock timeout/) }]);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end().catch(() => {});
    }
  });
});
