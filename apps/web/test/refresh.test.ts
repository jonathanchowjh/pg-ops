import { describe, expect, it } from 'vitest';
import { onSettle, shouldHold, tick, type TickState } from '../components/refresh.js';

describe('tick — the decision and the state transition', () => {
  const idle: TickState = { inFlight: false, requested: false, startedAt: null };

  /** Skipped, not queued: a queue would let a slow database accumulate refreshes and then receive a burst of them. */
  it('skips a tick that lands while one is already in flight, remembers it, and leaves startedAt alone', () => {
    const busy = { inFlight: true, requested: false, startedAt: 1000 };
    expect(tick(busy, 2000, true)).toEqual({ state: { ...busy, requested: true }, act: 'skip' });
    expect(tick(busy, 9999, true).state.startedAt).toBe(1000);
  });

  it('refreshes when nothing is in flight, stamping startedAt at the START of the refresh', () => {
    expect(tick(idle, 2000, false)).toEqual({ state: { inFlight: true, requested: false, startedAt: 2000 }, act: 'refresh' });
  });

  /**
   * A requested refresh is re-armed into a single slot, so it cannot be
   * swallowed by an in-flight refresh that started before the operator acted
   * and would show pre-action data.
   */
  it('refreshes once the in-flight one lands when a refresh was requested during it', () => {
    expect(tick({ inFlight: false, requested: true, startedAt: null }, 2000, false))
      .toEqual({ state: { inFlight: true, requested: false, startedAt: 2000 }, act: 'refresh' });
  });

  it('collapses several requests during one in-flight refresh into a single re-arm', () => {
    let s: TickState = { inFlight: true, requested: false, startedAt: 1000 };
    s = tick(s, 1100, true).state;
    s = tick(s, 1200, true).state;
    expect(s.requested).toBe(true);
    expect(tick(s, 1500, true).act).toBe('skip');
    expect(tick({ ...s, inFlight: false }, 1600, false).act).toBe('refresh');
  });
});

describe('onSettle', () => {
  /**
   * A refresh that settles with a request pending fires exactly one
   * follow-up and clears the flag, so N requests during one flight collapse
   * to a single re-arm.
   */
  it('fires exactly one follow-up when a request arrived during the flight', () => {
    const pending = { inFlight: true, requested: true, startedAt: 1000 };
    const settled = onSettle(pending);
    expect(settled.act).toBe('refresh');
    expect(settled.state.requested).toBe(false);
    // and the follow-up does not itself re-arm
    expect(onSettle(settled.state).act).toBe('idle');
  });

  it('goes idle when nothing was requested during the flight', () => {
    const quiet = { inFlight: true, requested: false, startedAt: 1000 };
    expect(onSettle(quiet).act).toBe('idle');
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

    expect(onSettle({ ...during.state, inFlight: false }).act).toBe('refresh');
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
