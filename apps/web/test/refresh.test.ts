import { describe, expect, it } from 'vitest';
import { nextTick, onSettle, onTick, tick, type TickState } from '../components/refresh.js';

describe('nextTick', () => {
  /**
   * Property 1: a tick landing while one is in flight is SKIPPED, not queued.
   * A queue would let a slow database accumulate refreshes and then receive a
   * burst of them — the tool adding load to the database it is diagnosing, at
   * the moment that database is least able to take it.
   */
  it('skips a tick that lands while one is already in flight', () => {
    expect(nextTick({ inFlight: true, requested: false, startedAt: 1000 }, 2000)).toEqual({ act: 'skip' });
  });

  it('refreshes when nothing is in flight', () => {
    expect(nextTick({ inFlight: false, requested: false, startedAt: null }, 2000)).toEqual({ act: 'refresh' });
  });

  /**
   * Property 3: an operator-requested refresh is re-armed into a single slot,
   * so it cannot be swallowed by an in-flight refresh that started BEFORE the
   * operator acted. Without this, a refresh fired right after an action shows
   * pre-action data and looks like the action did nothing.
   */
  it('refreshes once the in-flight one lands when a refresh was requested during it', () => {
    expect(nextTick({ inFlight: false, requested: true, startedAt: null }, 2000)).toEqual({ act: 'refresh' });
  });

  it('collapses several requests during one in-flight refresh into a single re-arm', () => {
    let s = { inFlight: true, requested: false, startedAt: 1000 };
    s = { ...s, requested: true };
    s = { ...s, requested: true };
    expect(s.requested).toBe(true);
    expect(nextTick(s, 1500)).toEqual({ act: 'skip' });
    expect(nextTick({ ...s, inFlight: false }, 1600)).toEqual({ act: 'refresh' });
  });
});

describe('onTick and onSettle — the state transitions', () => {
  const idle = { inFlight: false, requested: false, startedAt: null };

  /**
   * Property 1 again, but on the STATE rather than the decision: a tick that
   * lands mid-flight must be remembered, not dropped. The original `nextTick`
   * returned 'skip' and told the caller nothing about re-arming, so property 3
   * lived only in imperative effect code and its test passed for the same
   * reason as the one above it — vacuously.
   */
  it('remembers a tick that arrived while one was in flight', () => {
    const busy = { inFlight: true, requested: false, startedAt: 1000 };
    expect(onTick(busy, 2000).requested).toBe(true);
  });

  it('stamps startedAt at the START of the refresh it begins', () => {
    expect(onTick(idle, 2000)).toMatchObject({ inFlight: true, startedAt: 2000 });
  });

  it('does not move startedAt when it skips', () => {
    const busy = { inFlight: true, requested: false, startedAt: 1000 };
    expect(onTick(busy, 9999).startedAt).toBe(1000);
  });

  /**
   * Property 3, now actually enforced: a refresh that settles with a request
   * pending fires exactly ONE follow-up, and the pending flag clears — so the
   * refresh fired after an action cannot be swallowed by one that started
   * before it, and N requests during one flight collapse to a single re-arm
   * rather than N.
   */
  it('fires exactly one follow-up when a request arrived during the flight', () => {
    const pending = { inFlight: true, requested: true, startedAt: 1000 };
    const settled = onSettle(pending, 3000);
    expect(settled.act).toBe('refresh');
    expect(settled.state.requested).toBe(false);
    // and the follow-up does not itself re-arm
    expect(onSettle(settled.state, 4000).act).toBe('idle');
  });

  it('goes idle when nothing was requested during the flight', () => {
    const quiet = { inFlight: true, requested: false, startedAt: 1000 };
    expect(onSettle(quiet, 3000).act).toBe('idle');
  });
});

describe('tick — the loop the component actually runs', () => {
  /**
   * I2 (final review). The three tests above pin `nextTick`, `onTick` and
   * `onSettle`, and all three were already green — while production reached
   * none of their interesting branches, because the component decided
   * `inFlight` for itself with `setTimeout(…, 0)` after a fire-and-forget
   * `router.refresh()`. Replaying the shipped effect body verbatim, with a
   * server render taking five intervals: 10 refreshes issued, 0 ticks skipped,
   * 5 concurrent server renders against the database. That is the load
   * property 1 exists to prevent, produced by the code written to prevent it.
   *
   * So the loop takes `inFlight` as an argument now, and this drives that same
   * loop against the same scenario — the component supplies `useTransition`'s
   * `isPending`, the test supplies a modelled render duration, and it is the
   * SAME function in both. A test over the pure pieces alone could not have
   * caught this: every piece was right and the wiring was wrong.
   */
  it('skips every tick that lands while the server render is still in flight', () => {
    const intervalMs = 200;
    const renderMs = 1000; // five intervals — the review's scenario
    let state: TickState = { inFlight: false, requested: false, startedAt: null };
    let landsAt = 0;
    let issued = 0;
    let skipped = 0;
    let concurrent = 0;
    let peak = 0;

    for (let now = intervalMs; now <= 10 * intervalMs; now += intervalMs) {
      if (now >= landsAt) concurrent = 0;
      const t = tick(state, now, now < landsAt);
      state = t.state;
      if (t.act === 'skip') { skipped++; continue; }
      issued++;
      concurrent++;
      peak = Math.max(peak, concurrent);
      landsAt = now + renderMs;
    }

    expect({ issued, skipped, peak }).toEqual({ issued: 2, skipped: 8, peak: 1 });
  });

  /**
   * Property 3's first half, now on the path production takes: a tick skipped
   * mid-flight is REMEMBERED, so `onSettle` has something to re-arm. Under the
   * old timer `requested` was unreachable and `onSettle`'s refresh branch was
   * dead code.
   */
  it('records the skipped tick so the settle can re-arm it', () => {
    const idle: TickState = { inFlight: false, requested: false, startedAt: null };
    const started = tick(idle, 1000, false);
    expect(started.act).toBe('refresh');
    expect(started.state.startedAt).toBe(1000);

    const during = tick(started.state, 1200, true);
    expect(during.act).toBe('skip');
    expect(during.state.requested).toBe(true);
    expect(during.state.startedAt).toBe(1000);

    expect(onSettle({ ...during.state, inFlight: false }, 2000).act).toBe('refresh');
  });

  /**
   * The stored `inFlight` is never the authority — the transition is. A stale
   * `inFlight: true` left on the state must not wedge the ticker once the
   * transition has settled.
   */
  it('takes inFlight from the caller, not from the state it was handed', () => {
    const stale: TickState = { inFlight: true, requested: false, startedAt: 1000 };
    expect(tick(stale, 5000, false).act).toBe('refresh');
    expect(tick({ ...stale, inFlight: false }, 5000, true).act).toBe('skip');
  });
});
