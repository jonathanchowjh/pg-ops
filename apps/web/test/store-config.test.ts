// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { OWN_SQL_MARKER } from '@pgops/checks';
import { storePool, storeUrl } from '@/lib/store';

describe('storeUrl', () => {
  it('is null when PGOPS_STORE_URL is unset — no store, no DDL, no scheduler', () => {
    expect(storeUrl({})).toBeNull();
  });

  it('is null when set to the empty string, rather than an invalid pool', () => {
    expect(storeUrl({ PGOPS_STORE_URL: '' })).toBeNull();
  });

  it('is the URL when set', () => {
    expect(storeUrl({ PGOPS_STORE_URL: 'postgres://x/y' })).toBe('postgres://x/y');
  });

  it('never falls back to DATABASE_URL', () => {
    // The parent spec's fallback would have pgops issue CREATE SCHEMA against
    // a production database on the documented simplest deployment. Cut.
    expect(storeUrl({ DATABASE_URL: 'postgres://prod/app' })).toBeNull();
  });
});

describe('storePool', () => {
  // The cache is module-level state. Without this, each test's meaning
  // depends on what ran before it, and a test leaves STORE pointing at an
  // un-ended pool for whatever runs next. `storePool({})` is the reset,
  // because an unset PGOPS_STORE_URL now retires the cached pool.
  beforeEach(() => { storePool({}); });
  afterEach(() => { storePool({}); });

  it('retires the cached pool when PGOPS_STORE_URL is unset', () => {
    const first = storePool({ PGOPS_STORE_URL: 'postgres://x/first' });
    expect(storePool({})).toBeNull();
    // Leaving it open orphaned a Pool with live sockets — the same leak the
    // changed-URL case below covers, one branch over.
    expect(first!.ended).toBe(true);
  });

  it('evicts and ends the superseded pool when PGOPS_STORE_URL changes', () => {
    const first = storePool({ PGOPS_STORE_URL: 'postgres://x/first' });
    const second = storePool({ PGOPS_STORE_URL: 'postgres://x/second' });

    // A changed URL must not silently hand back the pool built for the old
    // one — that would make the `env` parameter a lie.
    expect(second).not.toBe(first);

    // Observable state, not a mock: neither pool ever connects (no query is
    // run here), so pg-pool's end() has nothing left to wait on and flips
    // `ended` synchronously — see node_modules/pg-pool's `_pulseQueue`. A
    // build that forgets to end the superseded pool leaves this `false`.
    expect(first!.ended).toBe(true);
    expect(second!.ended).toBe(false);
  });
});

/**
 * A8's gap, found by driving Stage 5.
 *
 * A8 stopped the console reporting its own polling as the database's load by
 * marking every statement `runCheck` issues with `OWN_SQL_MARKER`, which the
 * `queryStats` check then excludes. The STORE's statements never went through
 * `runCheck`, so none of them were marked.
 *
 * That only matters when `PGOPS_STORE_URL` points at a database pgops also
 * monitors — and `storePool`'s own comment already says the documented
 * single-database dev setup does exactly that. Measured on the dev console
 * with a freshly reset `pg_stat_statements`: three store READS appeared
 * unmarked on every page load, and over an hour of captures the store's
 * `INSERT INTO pgops.queries` was the NUMBER ONE statement by total time on
 * the Queries page. The console's headline answer to "what is slow here" was
 * the console describing itself.
 *
 * `application_name: pgops-store` already solved the sibling problem for the
 * Sessions list. This is the same idea for `pg_stat_statements`.
 *
 * Tested by spying on `Pool.prototype` BEFORE the pool is built, because the
 * wrapper captures the inner method at construction — so the spy becomes the
 * inner call and the assertion is on what the store would really send.
 */
describe('storePool — the store marks its own statements', () => {
  beforeEach(() => { storePool({}); });
  afterEach(() => { storePool({}); vi.restoreAllMocks(); });

  const ENV = { PGOPS_STORE_URL: 'postgres://x/y' };

  it('appends the marker to a statement issued on the pool', async () => {
    const inner = vi.spyOn(Pool.prototype, 'query').mockResolvedValue({ rows: [] } as never);
    const pool = storePool(ENV)!;
    await pool.query('SELECT 1');
    expect(inner).toHaveBeenCalled();
    expect(inner.mock.calls[0]![0]).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
  });

  /**
   * The form the store actually uses everywhere: `client.query(text, values)`
   * on a checked-out client. Wrapping only `pool.query` would have marked
   * nothing the store does, which is the whole defect.
   */
  it('appends the marker to a statement issued on a checked-out client', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ query, release: () => {} } as never);
    const pool = storePool(ENV)!;
    const client = await pool.connect();
    await client.query('INSERT INTO pgops.databases (name) VALUES ($1)', ['prod']);
    expect(query.mock.calls[0]![0]).toBe(`INSERT INTO pgops.databases (name) VALUES ($1)\n${OWN_SQL_MARKER}`);
    // The values must survive untouched — marking is a text change only.
    expect(query.mock.calls[0]![1]).toEqual(['prod']);
  });

  it('marks the config-object form and leaves its other fields alone', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ query, release: () => {} } as never);
    const pool = storePool(ENV)!;
    const client = await pool.connect();
    await client.query({ name: 'ins', text: 'SELECT $1::int', values: [1] } as never);
    const sent = query.mock.calls[0]![0] as { name: string; text: string; values: unknown[] };
    expect(sent.text).toBe(`SELECT $1::int\n${OWN_SQL_MARKER}`);
    // A named prepared statement's name must not change, or the server's
    // cached plan and this text stop agreeing.
    expect(sent.name).toBe('ins');
    expect(sent.values).toEqual([1]);
  });

  /**
   * Marking twice would change the text and so the queryid, splitting one
   * shape into two in `pg_stat_statements` — and `connect` is called once
   * per checked-out client, many times per pool.
   */
  it('marks a statement once, however many clients are checked out', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ query, release: () => {} } as never);
    const pool = storePool(ENV)!;
    for (let i = 0; i < 3; i++) {
      const c = await pool.connect();
      await c.query('SELECT 1');
    }
    for (const call of query.mock.calls) {
      expect(call[0]).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
    }
  });
});

/**
 * The regression the first version of the wrapper shipped, found by driving
 * the UI and not by any of 612 passing tests.
 *
 * `pool.connect` has TWO forms: `connect(): Promise<PoolClient>` and
 * `connect(cb)`, which returns `void`. The first wrapper only handled the
 * promise and did `innerConnect(...args).then(...)` unconditionally — so the
 * callback form threw `Cannot read properties of undefined (reading 'then')`.
 *
 * That is not an exotic path. `pg`'s own `Pool.query` calls
 * `this.connect(callback)` internally, so wrapping `connect` broke every
 * `pool.query` on the store pool, and the Queries page read:
 *
 *   History is configured but could not be read, so no since-last-capture
 *   figures are shown: Cannot read properties of undefined (reading 'then')
 *
 * The tests above could not catch it because every one of them used the
 * promise form — the wrapper was only ever asked the question it could
 * answer.
 */
describe('storePool — connect keeps both of its forms', () => {
  beforeEach(() => { storePool({}); });
  afterEach(() => { storePool({}); vi.restoreAllMocks(); });

  const ENV = { PGOPS_STORE_URL: 'postgres://x/y' };

  it('hands a marking client to the callback form, and returns no promise', () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const client = { query, release: () => {} };
    const done = () => {};
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(((cb?: unknown) => {
      (cb as (e: unknown, c: unknown, d: unknown) => void)(undefined, client, done);
      return undefined;
    }) as never);

    const pool = storePool(ENV)!;
    let got: { query: (...a: unknown[]) => unknown } | undefined;
    let gotDone: unknown;
    const returned = (pool.connect as unknown as (cb: (e: unknown, c: never, d: unknown) => void) => unknown)(
      (_e, c, d) => { got = c; gotDone = d; },
    );

    // pg's contract for this form: void, not a promise.
    expect(returned).toBeUndefined();
    expect(got).toBeDefined();
    // The `done` callback must travel through untouched — pg's own
    // Pool.query releases the client with it.
    expect(gotDone).toBe(done);
    void got!.query('SELECT 1');
    expect(query.mock.calls[0]![0]).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
  });

  /**
   * An error from the pool must reach the callback as an error, not as a
   * crash inside the wrapper — this is the path a store whose database is
   * down takes, and the console's whole claim is that it degrades to
   * "unavailable" rather than falling over.
   */
  it('passes a connection error through the callback form', () => {
    const boom = new Error('ECONNREFUSED');
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(((cb?: unknown) => {
      (cb as (e: unknown, c: unknown, d: unknown) => void)(boom, undefined, () => {});
      return undefined;
    }) as never);

    const pool = storePool(ENV)!;
    let seen: unknown;
    (pool.connect as unknown as (cb: (e: unknown, c: never, d: unknown) => void) => unknown)(
      (e) => { seen = e; },
    );
    expect(seen).toBe(boom);
  });
});
