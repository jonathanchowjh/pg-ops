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

  /**
   * The pool bounds every statement, and Server lists the server's own
   * timeouts. A timeout sent in the startup packet would be reported as the
   * server's, so a server with none would never read "off".
   */
  it("bounds pgops's statements and still reports the server's timeouts", async () => {
    const { contextFor } = await import('../lib/pools.js');
    const { runCheckFor } = await import('../lib/check.js');
    const ctx = await contextFor('primary');
    const { rows } = await ctx.target.query<{ s: string; l: string }>(
      "SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l");
    expect(rows[0]).toEqual({ s: '15s', l: '1s' });
    const r = await runCheckFor('primary', CHECKS.settings);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const shown = Object.fromEntries(r.data.main.map((s) => [s.name, s.value]));
    expect(shown.statement_timeout).toBe('0');
    expect(shown.lock_timeout).toBe('0');
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

/**
 * The promise the add-database modal makes, held at the server: every
 * connection pgops opens to a monitored database is read only, and what the
 * actions do is still allowed there.
 */
describe('a monitored database', () => {
  it('refuses a write over pgops\'s own connection with 25006', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const { target } = await contextFor('primary');
    await expect(target.query('CREATE TABLE pgops_wrote (id int)')).rejects.toMatchObject({ code: '25006' });
    // Set at startup, so it is the session's reset value: RESET cannot undo it.
    const client = await target.connect();
    try {
      await client.query('RESET ALL');
      await expect(client.query('CREATE TABLE pgops_wrote (id int)')).rejects.toMatchObject({ code: '25006' });
    } finally {
      client.release();
    }
  });

  /** A SET there would outlive pgops's session on a pooler's shared connection. */
  it('is read only from the startup packet, not a SET', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const { target } = await contextFor('primary');
    const { rows: [s] } = await target.query<{ reset_val: string; source: string }>(
      "SELECT reset_val, source FROM pg_settings WHERE name = 'default_transaction_read_only'");
    expect(s).toEqual({ reset_val: 'on', source: 'client' });
  });

  it('closes the pool of a removed database, and keeps one another name still uses', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { removeDatabase } = await import('../lib/config.js');
    const { contextFor, retireTarget } = await import('../lib/pools.js');
    const file = join(mkdtempSync(join(tmpdir(), 'pgops-retire-')), 'databases.json');
    const url = `${pg.getConnectionUri()}?retire=1`;
    writeFileSync(file, JSON.stringify([{ name: 'a', url }, { name: 'b', url }]));
    const before = process.env.PGOPS_CONFIG_FILE;
    process.env.PGOPS_CONFIG_FILE = file;
    try {
      const { target } = await contextFor('a');
      retireTarget(removeDatabase(process.env, 'a').url);
      expect((target as unknown as { ending: boolean }).ending).toBe(false);
      retireTarget(removeDatabase(process.env, 'b').url);
      expect((target as unknown as { ending: boolean }).ending).toBe(true);
    } finally {
      process.env.PGOPS_CONFIG_FILE = before;
    }
  });

  it('still allows ANALYZE, a statistics reset and a terminate', async () => {
    const { Client } = await import('pg');
    const { contextFor } = await import('../lib/pools.js');
    const { target } = await contextFor('primary');
    const victim = new Client({ connectionString: pg.getConnectionUri() });
    await victim.connect();
    victim.on('error', () => {});
    const { rows: [me] } = await victim.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await target.query('ANALYZE pg_catalog.pg_class');
    await target.query('SELECT pg_stat_reset()');
    const { rows: [killed] } = await target.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [me!.pid]);
    expect(killed!.ok).toBe(true);
    await victim.end().catch(() => {});
  });

  it('is probed the way it is connected: who it is, and read only', async () => {
    const { probe } = await import('../lib/pools.js');
    const r = await probe(pg.getConnectionUri());
    expect(r.readOnly).toBe(true);
    expect(r.identity.database).toBe(pg.getDatabase());
    await expect(probe('postgres://u:p@127.0.0.1:1/nope')).rejects.toThrow();
  });
});
