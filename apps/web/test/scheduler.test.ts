// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_INTERVAL_MS, HEALTH_INTERVAL_MS, HEALTH_SLOW_PASS_MS, startScheduler, stopScheduler,
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

    // Captures immediately, in configuration order. A deployment restarting
    // faster than the capture interval otherwise records nothing at all.
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

    // The boot capture is still in flight (its promise is held open below),
    // so both interval ticks must be SKIPPED, not queued behind it — a queued
    // tick runs a capture nobody needs against a database pgops is meant to be
    // leaving alone.
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
    // One at boot, then one per interval — and no rejection escapes any of
    // them. An unhandled rejection on a timer terminates the process.
    await expect(vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS)).resolves.not.toThrow();
    await vi.advanceTimersByTimeAsync(CAPTURE_INTERVAL_MS);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it('does not start twice, even when the two calls OVERLAP', async () => {
    // The guard used to be `if (timer !== null) return true`, read BEFORE the
    // await on migrate and written AFTER it — so two overlapping calls both
    // passed it, both migrated, and both setInterval'd. The first handle was
    // overwritten and lost, leaving an interval stopScheduler could never
    // clear, calling capture against the monitored databases forever. Awaiting
    // the two calls sequentially, as the original test did, cannot see this.
    let release!: () => void;
    const migrate = vi.fn().mockImplementation(
      () => new Promise<number>((r) => { release = () => r(1); }),
    );
    const deps = { store: {} as never, names: () => ['prod'], capture: vi.fn(), migrate };
    const a = startScheduler(deps);
    const b = startScheduler(deps);
    // Release only ONE pending migrate. If both calls got past the guard,
    // `b`'s migrate is still pending and this await hangs — so assert on the
    // count first, which fails immediately and says what went wrong, rather
    // than letting the test die by timeout.
    release();
    await a;
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(await b).toBe(true);
  });

  it('does not take the console down when the store cannot be migrated', async () => {
    // Every other path in this feature swallows, and says so in a docblock:
    // a console that dies because a store blinked is worse than one that
    // reports history as unavailable. register() is awaited by Next during
    // server preparation, so a rejection here is the whole app failing to
    // boot because its OPTIONAL history store was slow to come up.
    const migrate = vi.fn().mockRejectedValue(new Error('the store is still starting'));
    const capture = vi.fn();
    const started = await startScheduler({
      store: {} as never, names: () => ['prod'], capture, migrate,
    });
    expect(started).toBe(false);
    // Not vacuous: startScheduler now captures once immediately on success,
    // so "capture was never called" genuinely distinguishes the failed-migrate
    // path from the successful one. Nothing may run against an unmigrated
    // store — at boot or on the interval.
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

  /**
   * Final review. A row with a part missing is still `ok: true`, and nothing
   * read `missing`: a statement that failed every minute left its charts
   * blank for ever and the log silent.
   */
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
