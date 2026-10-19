import { describe, expect, it } from 'vitest';
import { nextTick, onSettle, onTick, shouldHold, tick, type TickState } from '../components/refresh.js';

describe('nextTick', () => {
  /**
   * Skipped, not queued: a queue would let a slow database accumulate
   * refreshes and then receive a burst of them.
   */
  it('skips a tick that lands while one is already in flight', () => {
    expect(nextTick({ inFlight: true, requested: false, startedAt: 1000 }, 2000)).toEqual({ act: 'skip' });
  });

  it('refreshes when nothing is in flight', () => {
    expect(nextTick({ inFlight: false, requested: false, startedAt: null }, 2000)).toEqual({ act: 'refresh' });
  });

  /**
   * A requested refresh is re-armed into a single slot, so it cannot be
   * swallowed by an in-flight refresh that started before the operator acted
   * and would show pre-action data.
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

  /** On the state rather than the decision: a tick that lands mid-flight is remembered, not dropped. */
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
   * A refresh that settles with a request pending fires exactly one
   * follow-up and clears the flag, so N requests during one flight collapse
   * to a single re-arm.
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

describe('shouldHold — the poll yields to the reader', () => {
  /**
   * Page height changes between polls. When the document shrinks below
   * `scrollY + innerHeight` the browser clamps the scroll position, so the
   * page jumps under a reader who has scrolled down.
   */
  it('runs at the top, where a change below the fold moves nothing', () => {
    expect(shouldHold(0)).toBe(false);
  });

  it('tolerates the pixel or two a resting trackpad reports', () => {
    expect(shouldHold(1)).toBe(false);
    expect(shouldHold(8)).toBe(false);
  });

  it('holds once the reader has actually scrolled', () => {
    expect(shouldHold(9)).toBe(true);
    expect(shouldHold(2_000)).toBe(true);
  });
});

describe('tick — holding is not skipping', () => {
  const idle = { inFlight: false, requested: false, startedAt: null };

  it('does not fire while the reader is scrolled away', () => {
    expect(tick(idle, 1000, false, true).act).toBe('hold');
  });

  /**
   * A skip records itself so the settle can re-arm it. A hold owes nothing:
   * re-arming would fire a refresh, and move the page, the moment the reader
   * scrolled back to the top.
   */
  it('leaves the state untouched, so nothing is owed a follow-up', () => {
    const held = tick(idle, 1000, false, true);
    expect(held.state).toEqual(idle);
    expect(held.state.requested).toBe(false);
    expect(held.state.startedAt).toBeNull();
  });

  it('still refreshes at the top, and still skips a tick that lands mid-flight', () => {
    expect(tick(idle, 1000, false, false).act).toBe('refresh');
    expect(tick(idle, 1000, true, false).act).toBe('skip');
  });

  /** The hold outranks the flight: neither one should reach the database. */
  it('holds rather than skips when both would stop it', () => {
    expect(tick(idle, 1000, true, true).act).toBe('hold');
  });
});

describe('tick — the loop the component actually runs', () => {
  /**
   * Drives the same `tick` the component runs, with `inFlight` supplied by
   * the caller: the component passes `useTransition`'s `isPending`, this test
   * a modelled render duration. Tests over the pure pieces alone pass even
   * when the component wires `inFlight` wrongly and issues concurrent renders.
   */
  it('skips every tick that lands while the server render is still in flight', () => {
    const intervalMs = 200;
    const renderMs = 1000; // five intervals
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

  /** On the path production takes: a tick skipped mid-flight is remembered, so `onSettle` has something to re-arm. */
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
   * The transition is the authority, not the stored `inFlight`: a stale
   * `inFlight: true` on the state must not wedge the ticker.
   */
  it('takes inFlight from the caller, not from the state it was handed', () => {
    const stale: TickState = { inFlight: true, requested: false, startedAt: 1000 };
    expect(tick(stale, 5000, false).act).toBe('refresh');
    expect(tick({ ...stale, inFlight: false }, 5000, true).act).toBe('skip');
  });
});
