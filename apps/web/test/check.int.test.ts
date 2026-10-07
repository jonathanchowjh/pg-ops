import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECKS } from '@pgops/checks';

/**
 * I4 (final review): hardcoded `postgres:17-alpine` until now, so every CI
 * matrix leg ran this file against 17 regardless of which version it claimed
 * to be testing. Same expression as packages/checks/test/global-setup.ts.
 */
const IMAGE = `postgres:${process.env.PGOPS_TEST_PG_VERSION ?? '17'}-alpine`;

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
   * The serverVersion in the context must be the REAL one read from the
   * server, not a constant. A hardcoded floor would make every version-gated
   * check appear supported on a server that does not support it -- the exact
   * failure `requires: {kind:'version'}` exists to prevent.
   */
  it('probes the real server version into the context', async () => {
    const { contextFor } = await import('../lib/pools.js');
    const ctx = await contextFor('primary');
    expect(ctx.serverVersion).toBeGreaterThanOrEqual(140000);
    const { rows } = await ctx.target.query<{ server_version_num: string }>('SHOW server_version_num');
    expect(ctx.serverVersion).toBe(Number(rows[0]!.server_version_num));
  });

  /**
   * One pool per database for the process lifetime. A pool per request would
   * exhaust max_connections on the database this tool exists to diagnose,
   * during the incident it exists to diagnose it.
   */
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

  /**
   * runCheck never rejects, and neither does this. A page renders a failed
   * check; it must never render a stack trace.
   */
  it('returns ok:false rather than rejecting when a check cannot run', async () => {
    const { runCheckFor } = await import('../lib/check.js');
    const broken = { ...CHECKS.connections, sql: 'SELECT * FROM does_not_exist' };
    const r = await runCheckFor('primary', broken);
    expect(r.ok).toBe(false);
  });
});

/**
 * Final review. Only `pool.query` was counted, and the health tick samples
 * on a checked-out client: the commit chart showed a floor of pgops's own
 * making while "statements pgops itself sent" read zero, which is the case
 * that line was added for.
 */
describe('ownStatementsTotal', () => {
  it('counts statements sent on a checked-out client, but not transaction control', async () => {
    const { contextFor, ownStatementsTotal } = await import('../lib/pools.js');
    const ctx = await contextFor('primary');
    const before = ownStatementsTotal('primary');
    const client = await ctx.target.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 5000');
      await client.query('SELECT 1');
      await client.query({ text: 'SELECT 2' });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(ownStatementsTotal('primary') - before).toBe(2);
    // The same client comes back from the pool; it must not be wrapped twice.
    const again = await ctx.target.connect();
    try {
      await again.query('SELECT 3');
    } finally {
      again.release();
    }
    expect(ownStatementsTotal('primary') - before).toBe(3);
  });
});
