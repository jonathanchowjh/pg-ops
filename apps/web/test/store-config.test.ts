// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { OWN_SQL_MARKER } from '@pgops/checks';
import { storeUrl } from '@/lib/config';
import { onEveryStatement, storePool } from '@/lib/pools';

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
    // A fallback would have pgops issue CREATE SCHEMA against a production database.
    expect(storeUrl({ DATABASE_URL: 'postgres://prod/app' })).toBeNull();
  });
});

describe('storePool', () => {
  // The cache is process-wide state. `storePool({})` is the reset: an unset
  // PGOPS_STORE_URL retires the cached pool.
  beforeEach(() => { storePool({}); });
  afterEach(() => { storePool({}); });

  it('retires the cached pool when PGOPS_STORE_URL is unset', () => {
    const first = storePool({ PGOPS_STORE_URL: 'postgres://x/first' });
    expect(storePool({})).toBeNull();
    // Left open, it would be an orphaned Pool with live sockets.
    expect(first!.ended).toBe(true);
  });

  it('bounds every statement, so a store that hangs falls back like one that fails', () => {
    const pool = storePool({ PGOPS_STORE_URL: 'postgres://x/bounded' })!;
    const opts = pool.options as { statement_timeout?: number; lock_timeout?: number };
    expect(opts.statement_timeout).toBe(10_000);
    expect(opts.lock_timeout).toBe(2_000);
  });

  it('is one pool per process, however many copies of the module Next bundles', async () => {
    const first = storePool({ PGOPS_STORE_URL: 'postgres://x/one' });
    vi.resetModules();
    // A second evaluation of the module, as the instrumentation and page bundles each have.
    const again = await import('@/lib/pools');
    expect(again.storePool({ PGOPS_STORE_URL: 'postgres://x/one' })).toBe(first);
  });

  it('evicts and ends the superseded pool when PGOPS_STORE_URL changes', () => {
    const first = storePool({ PGOPS_STORE_URL: 'postgres://x/first' });
    const second = storePool({ PGOPS_STORE_URL: 'postgres://x/second' });

    expect(second).not.toBe(first);

    // Neither pool ever connects, so pg-pool's end() flips `ended`
    // synchronously (see pg-pool's `_pulseQueue`).
    expect(first!.ended).toBe(true);
    expect(second!.ended).toBe(false);
  });
});

/**
 * `queryStats` excludes statements carrying `OWN_SQL_MARKER`. The store's
 * statements do not go through `runCheck`, so the store pool marks them
 * itself; otherwise, when `PGOPS_STORE_URL` points at a database pgops also
 * monitors, the store's own statements rank on the Queries page.
 *
 * `Pool.prototype` is spied on before the pool is built, because the wrapper
 * captures the inner method at construction.
 */
describe('storePool — the store marks its own statements', () => {
  beforeEach(() => { storePool({}); });
  afterEach(() => { storePool({}); vi.restoreAllMocks(); });

  const ENV = { PGOPS_STORE_URL: 'postgres://x/y' };

  /**
   * Through pg's real `Pool.query`, which checks a client out with the
   * callback form of `connect`. Exactly once: wrapping `pool.query` as well
   * as the client sent the marker twice.
   */
  it('appends the marker once to a statement issued on the pool', async () => {
    const query = vi.fn((_text: unknown, _values: unknown, cb: (e: unknown, r: unknown) => void) => {
      cb(undefined, { rows: [] });
    });
    const client = { query, release: () => {}, once: () => {}, removeListener: () => {} };
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(((cb?: unknown) => {
      (cb as (e: unknown, c: unknown, d: unknown) => void)(undefined, client, () => {});
      return undefined;
    }) as never);
    const pool = storePool(ENV)!;
    await pool.query('SELECT 1');
    expect(query.mock.calls[0]![0]).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
  });

  /**
   * The form the store actually uses: `client.query(text, values)` on a
   * checked-out client. Wrapping only `pool.query` would mark nothing.
   */
  it('appends the marker to a statement issued on a checked-out client', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ query, release: () => {} } as never);
    const pool = storePool(ENV)!;
    const client = await pool.connect();
    await client.query('INSERT INTO pgops.databases (name) VALUES ($1)', ['prod']);
    expect(query.mock.calls[0]![0]).toBe(`INSERT INTO pgops.databases (name) VALUES ($1)\n${OWN_SQL_MARKER}`);
    // Marking is a text change only.
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
 * `pool.connect` has two forms: `connect(): Promise<PoolClient>` and
 * `connect(cb)`, which returns `void`. `pg`'s own `Pool.query` calls
 * `this.connect(callback)` internally, so a wrapper that handles only the
 * promise form breaks every `pool.query` on the store pool.
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
    // pg's own Pool.query releases the client with `done`.
    expect(gotDone).toBe(done);
    void got!.query('SELECT 1');
    expect(query.mock.calls[0]![0]).toBe(`SELECT 1\n${OWN_SQL_MARKER}`);
  });

  /** The path a store whose database is down takes: the error must reach the callback, not crash the wrapper. */
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

/**
 * Both pools reach the database through onEveryStatement's connect. A
 * refusal of `localhost` on both stacks arrives as an AggregateError with
 * an empty message: it logged nothing, and in dev React's stream could not
 * revive it and the page never finished.
 */
describe('onEveryStatement and a refused connect', () => {
  const refused = (): Error => Object.assign(new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
  ], ''), { code: 'ECONNREFUSED' });
  const pool = (): Pool => ({
    connect: (cb?: (err: unknown) => void) => {
      if (cb) { cb(refused()); return undefined; }
      return Promise.reject(refused());
    },
  }) as unknown as Pool;
  const plain = (err: unknown): void => {
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AggregateError);
    expect((err as Error).message).toBe('connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1');
    // What classify reads to call the database unreachable.
    expect((err as { code?: string }).code).toBe('ECONNREFUSED');
  };

  it('rejects a promise connect with a plain Error that names the refusal and keeps its code', async () => {
    const p = pool();
    onEveryStatement(p, (a) => a);
    plain(await p.connect().then(() => null, (err: unknown) => err));
  });

  it('hands a callback connect the same', async () => {
    const p = pool();
    onEveryStatement(p, (a) => a);
    plain(await new Promise((resolve) => { p.connect((err) => resolve(err)); }));
  });
});
