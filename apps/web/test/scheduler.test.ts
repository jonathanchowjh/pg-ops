// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_INTERVAL_MS, HEALTH_INTERVAL_MS, HEALTH_SLOW_PASS_MS, PLACE_INTERVAL_MS, SAMPLE_INTERVAL_MS, startScheduler, stopScheduler,
} from '@/lib/scheduler';

afterEach(() => { stopScheduler(); vi.useRealTimers(); });

describe('startScheduler', () => {
  it('does nothing without a store — no timer, no capture, no DDL', async () => {
    const capture = vi.fn();
    const migrate = vi.fn();
    const started = await startScheduler({ store: null, names: () => ['prod'], capture, migrate });
    expect(started).toBe(false);
    expect(migrate).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it('migrates once at boot, then captures every configured database', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockResolvedValue({ ok: true });
    const migrate = vi.fn().mockResolvedValue(1);
    const store = {} as never;

    await startScheduler({ store, names: () => ['prod', 'analytics'], capture, migrate });
    expect(migrate).toHaveBeenCalledTimes(1);

    // Captures immediately: a deployment restarting faster than the capture
    // interval would otherwise record nothing.
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.mock.calls.map((c) => c[0])).toEqual(['prod', 'analytics']);

    // ...and again on the interval.
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    expect(capture.mock.calls.map((c) => c[0]))
      .toEqual(['prod', 'analytics', 'prod', 'analytics']);
  });

  it('SKIPS a tick that lands while one is in flight, never queues it', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const capture = vi.fn().mockImplementation(
      () => new Promise((r) => { release = () => r({ ok: true }); }),
    );
    await startScheduler({
      store: {} as never, names: () => ['prod'], capture,
      migrate: vi.fn().mockResolvedValue(1),
    });

    // The boot capture is still in flight (its promise is held open), so both
    // interval ticks must be skipped.
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    expect(capture).toHaveBeenCalledTimes(1);
    release();
  });

  it('survives a capture that rejects — a background rejection kills the process', async () => {
    vi.useFakeTimers();
    const capture = vi.fn().mockRejectedValue(new Error('store gone'));
    await startScheduler({
      store: {} as never, names: () => ['prod'], capture,
      migrate: vi.fn().mockResolvedValue(1),
    });
    // One at boot, then one per interval, and no rejection escapes any of them.
    await expect(vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS)).resolves.not.toThrow();
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  /** `localhost` refused on both stacks is an AggregateError with an empty message: the log said nothing. */
  it('logs why a capture failed when the error has no message of its own', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = new AggregateError([new Error('connect ECONNREFUSED ::1:5432'), new Error('connect ECONNREFUSED 127.0.0.1:5432')], '');
    try {
      await startScheduler({
        store: {} as never, names: () => ['prod'], capture: vi.fn().mockRejectedValue(refused),
        migrate: vi.fn().mockRejectedValue(refused),
      });
      await vi.advanceTimersByTimeAsync(0);
      const said = error.mock.calls.map((c) => c.slice(1).join(' ')).join('\n');
      expect(said).not.toMatch(/AggregateError/);
      expect(said).toContain('connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
    } finally {
      error.mockRestore();
    }
  });

  it('does not start twice, even when the two calls OVERLAP', async () => {
    // A guard read before the await on migrate and written after it lets two
    // overlapping calls both pass, both migrate and both setInterval, leaking
    // an interval stopScheduler can never clear. Sequential awaits cannot see this.
    let release!: () => void;
    const migrate = vi.fn().mockImplementation(
      () => new Promise<number>((r) => { release = () => r(1); }),
    );
    const deps = { store: {} as never, names: () => ['prod'], capture: vi.fn(), migrate };
    const a = startScheduler(deps);
    const b = startScheduler(deps);
    // Release only one pending migrate. If both calls got past the guard,
    // `await b` would hang, so the count is asserted first.
    release();
    await a;
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(await b).toBe(true);
  });

  it('does not take the console down when the store cannot be migrated', async () => {
    // register() is awaited by Next during server preparation, so a rejection
    // here would stop the whole app booting over its optional history store.
    const migrate = vi.fn().mockRejectedValue(new Error('the store is still starting'));
    const capture = vi.fn();
    const started = await startScheduler({
      store: {} as never, names: () => ['prod'], capture, migrate,
    });
    expect(started).toBe(false);
    // Nothing may run against an unmigrated store, at boot or on the interval.
    // (A successful start captures once immediately, so this can fail.)
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS * 2);
    expect(capture).not.toHaveBeenCalled();
  });

  it('does not start twice', async () => {
    const migrate = vi.fn().mockResolvedValue(1);
    const deps = { store: {} as never, names: () => ['prod'], capture: vi.fn(), migrate };
    await startScheduler(deps);
    await startScheduler(deps);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it('does not run a second capture beside one still in flight across a stop and a start', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const capture = vi.fn().mockImplementation(() => new Promise((r) => { release = () => r({ ok: true }); }));
    const deps = { store: {} as never, names: () => ['prod'], capture, migrate: vi.fn().mockResolvedValue(1) };
    await startScheduler(deps);
    await vi.advanceTimersByTimeAsync(0);
    stopScheduler();
    await startScheduler(deps);
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    expect(capture).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe('the health tick', () => {
  const base = () => ({
    store: {} as never,
    names: () => ['prod', 'analytics'],
    capture: vi.fn().mockResolvedValue({ ok: true }),
    migrate: vi.fn().mockResolvedValue(1),
  });

  it('samples every database at boot and every minute after', async () => {
    vi.useFakeTimers();
    const health = vi.fn().mockResolvedValue({ ok: true, missing: [] });
    await startScheduler({ ...base(), health });
    await vi.advanceTimersByTimeAsync(0);
    expect(health.mock.calls.map((c) => c[0])).toEqual(['prod', 'analytics']);
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    expect(health).toHaveBeenCalledTimes(4);
  });

  it('runs beside a capture that is still in flight', async () => {
    vi.useFakeTimers();
    const health = vi.fn().mockResolvedValue({ ok: true, missing: [] });
    let release!: () => void;
    const capture = vi.fn().mockImplementation(
      () => new Promise((r) => { release = () => r({ ok: true }); }),
    );
    await startScheduler({ ...base(), names: () => ['prod'], capture, health });
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(4);
    // Released, or the module's `running` flag stays set and starves every later test.
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('skips a tick that lands while one is in flight', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const health = vi.fn().mockImplementation(
      () => new Promise((r) => { release = () => r({ ok: true, missing: [] }); }),
    );
    await startScheduler({ ...base(), names: () => ['prod'], health });
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2);
    expect(health).toHaveBeenCalledTimes(1);
    release();
  });

  it('stops with the scheduler', async () => {
    vi.useFakeTimers();
    const health = vi.fn().mockResolvedValue({ ok: true, missing: [] });
    await startScheduler({ ...base(), health });
    await vi.advanceTimersByTimeAsync(0);
    stopScheduler();
    await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it('logs an outage once, not once a minute, and logs the recovery', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let down = true;
    const health = vi.fn().mockImplementation(async () => (
      down ? { ok: false, reason: 'unreachable', message: 'connection refused' } : { ok: true, missing: [] }
    ));
    try {
      await startScheduler({ ...base(), names: () => ['prod'], health });
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 5);
      expect(error.mock.calls.filter((c) => String(c[0]).includes('health'))).toHaveLength(1);
      down = false;
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(info.mock.calls.filter((c) => String(c[0]).includes('recovered'))).toHaveLength(1);
    } finally {
      error.mockRestore();
      info.mockRestore();
    }
  });

  it('survives a health call that rejects', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const health = vi.fn().mockRejectedValue(new Error('store gone'));
    try {
      await startScheduler({ ...base(), names: () => ['prod'], health });
      await expect(vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2)).resolves.not.toThrow();
      expect(health).toHaveBeenCalledTimes(3);
    } finally {
      error.mockRestore();
    }
  });

  it('says so when one pass takes longer than half its interval', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const health = vi.fn().mockImplementation(
      () => new Promise((r) => { setTimeout(() => r({ ok: true, missing: [] }), HEALTH_SLOW_PASS_MS + 1_000); }),
    );
    try {
      await startScheduler({ ...base(), names: () => ['prod'], health });
      await vi.advanceTimersByTimeAsync(HEALTH_SLOW_PASS_MS + 2_000);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('health pass'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('does nothing when no health function is given', async () => {
    vi.useFakeTimers();
    await startScheduler(base());
    await expect(vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2)).resolves.not.toThrow();
  });

  /** A row with a part missing is still `ok: true`, so `missing` must be logged or the gap is silent. */
  it('names the parts it could not read, once, and says when they come back', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let missing = ['size', 'replication'];
    const health = vi.fn().mockImplementation(async () => ({ ok: true, missing }));
    try {
      await startScheduler({ ...base(), names: () => ['prod'], health });
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 4);
      const partial = warn.mock.calls.filter((c) => String(c[0]).includes('could not read'));
      expect(partial).toHaveLength(1);
      expect(partial[0]!.join(' ')).toContain('size, replication');
      missing = [];
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
      expect(info.mock.calls.filter((c) => String(c[0]).includes('reads every part again'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});

describe('the sample tick', () => {
  it('samples every fifteen seconds with no store at all', async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async (_name: string) => {});
    const started = await startScheduler({ store: null, names: () => ['a', 'b'], capture: vi.fn(), migrate: vi.fn(), sample });
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sample.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(sample).toHaveBeenCalledTimes(4);
  });

  it('still starts nothing with no store and no sampler', async () => {
    expect(await startScheduler({ store: null, names: () => [], capture: vi.fn(), migrate: vi.fn() })).toBe(false);
  });

  it('skips a sample pass while the one before it is still running', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const sample = vi.fn(() => new Promise<void>((r) => { release = r; }));
    await startScheduler({ store: null, names: () => ['a'], capture: vi.fn(), migrate: vi.fn(), sample });
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
    expect(sample).toHaveBeenCalledTimes(1);
    // Released and settled, or the module's `sampling` flag starves every later test.
    release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('samples the other databases while one is slow to answer', async () => {
    let answer = (): void => {};
    const sample = vi.fn((name: string) => (name === 'slow' ? new Promise<void>((r) => { answer = r; }) : Promise.resolve()));
    await startScheduler({ store: null, names: () => ['slow', 'a', 'b'], capture: vi.fn(), migrate: vi.fn(), sample });
    await Promise.resolve();
    expect(sample.mock.calls.map((c) => c[0])).toEqual(['slow', 'a', 'b']);
    answer();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('samples when the store could not be migrated', async () => {
    vi.useFakeTimers();
    const sample = vi.fn(async (_name: string) => {});
    const migrate = vi.fn(async () => { throw new Error('store down'); });
    expect(await startScheduler({ store: {} as never, names: () => ['a'], capture: vi.fn(), migrate, sample })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sample).toHaveBeenCalledTimes(1);
  });
});

describe('the placement tick', () => {
  const store = {} as never;
  const base = () => ({ store, names: () => ['a'], capture: vi.fn().mockResolvedValue({ ok: true }), migrate: vi.fn().mockResolvedValue(1) });

  it('plans at boot and then once a minute, with a store', async () => {
    vi.useFakeTimers();
    const place = vi.fn(async (_name: string) => {});
    await startScheduler({ ...base(), place });
    await vi.advanceTimersByTimeAsync(0);
    expect(place).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PLACE_INTERVAL_MS);
    expect(place).toHaveBeenCalledTimes(2);
  });

  it('plans nothing without a store: the shapes are the store\'s', async () => {
    vi.useFakeTimers();
    const place = vi.fn(async (_name: string) => {});
    await startScheduler({ store: null, names: () => ['a'], capture: vi.fn(), migrate: vi.fn(), sample: vi.fn(async () => {}), place });
    await vi.advanceTimersByTimeAsync(PLACE_INTERVAL_MS * 2);
    expect(place).not.toHaveBeenCalled();
  });

  it('skips a pass while the one before it is still running', async () => {
    vi.useFakeTimers();
    let release = () => {};
    const place = vi.fn(() => new Promise<void>((r) => { release = r; }));
    await startScheduler({ ...base(), place });
    await vi.advanceTimersByTimeAsync(PLACE_INTERVAL_MS * 3);
    expect(place).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});
