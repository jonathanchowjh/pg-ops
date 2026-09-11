// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
