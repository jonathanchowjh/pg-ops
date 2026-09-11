// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_INTERVAL_MS, startScheduler, stopScheduler } from '@/lib/scheduler';

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
