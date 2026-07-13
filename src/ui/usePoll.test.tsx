import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshnessLabel } from './freshness.js';
import { usePoll } from './usePoll.js';

/**
 * Regression tests for deep-review C1/C2: a poll that outlives its interval.
 *
 * On the slow, contended database this tool exists for, a poll can easily exceed
 * the 2s cadence. Before the in-flight guard, the next tick fired anyway: it
 * could resolve FIRST, and then the older, slower poll would land on top of it —
 * rendering 5-second-old numbers labelled "updated just now" — while doubling
 * the query volume pgops itself puts on the already-struggling database.
 */

const REFRESH_MS = 60;

/**
 * Every payload usePoll handed the view, in the order it handed them over. This
 * is the exact sequence the operator's screen went through — the C1 bug is a
 * STALE payload arriving after a fresher one, which is invisible to a snapshot
 * of the final frame (the stale render can flash by in milliseconds) and obvious
 * here.
 */
let rendered: string[] = [];
beforeEach(() => {
  rendered = [];
});

/** A tiny view that prints exactly what usePoll gives it. */
function Probe({
  fetch,
  refreshMs = REFRESH_MS,
  expose,
}: {
  fetch: () => Promise<string>;
  refreshMs?: number;
  /** Hands `refresh()` out to the test — this is what the kill path calls. */
  expose?: (refresh: () => void) => void;
}) {
  const [data, setData] = useState('none');
  const { lastPollAt, error, refresh } = usePoll<string>({
    fetch,
    onData: (d) => {
      rendered.push(d);
      setData(d);
    },
    refreshMs,
  });
  expose?.(refresh);
  return (
    <Text>
      data={data} freshness={freshnessLabel(lastPollAt)} error={error ?? '-'}
    </Text>
  );
}

/**
 * Every mounted probe keeps polling until it is unmounted; a leaked one from an
 * earlier test steals event-loop time from the next one's timing assertions.
 */
const mounted: (() => void)[] = [];
function mount(fetch: () => Promise<string>, opts: { refreshMs?: number } = {}) {
  let refresh: () => void = () => {};
  const instance = render(
    <Probe fetch={fetch} refreshMs={opts.refreshMs} expose={(r) => (refresh = r)} />,
  );
  mounted.push(instance.unmount);
  return { ...instance, refresh: () => refresh() };
}
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** A promise that resolves with `value` after `ms` — a poll slower than the interval. */
function slow<T>(value: T, ms: number): Promise<T> {
  return new Promise((r) => setTimeout(() => r(value), ms));
}

describe('usePoll — in-flight guard', () => {
  it('skips a tick while a poll is still in flight (skipped, not queued)', async () => {
    // The first poll takes five intervals. Every tick in that window must be
    // SKIPPED: this is what stops pgops from multiplying its own query volume
    // against a database too slow to answer inside one interval (C2).
    const fetch = vi.fn().mockReturnValueOnce(slow('A', REFRESH_MS * 5)).mockResolvedValue('B');
    mount(fetch);

    await wait(REFRESH_MS * 3.5); // three more ticks would have fired by now
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a late poll can never overwrite the newer data that landed while it was running', async () => {
    // A is slow and started first; B is fast. Unguarded, the tick at t=1×REFRESH
    // fires anyway, B renders — and then A lands ON TOP of it at t=4×REFRESH,
    // reverting the screen to older numbers and re-stamping them "updated just
    // now". The observable is the SEQUENCE of payloads the view was handed: once
    // fresher data has been rendered, staler data must never follow it.
    const fetch = vi.fn().mockReturnValueOnce(slow('A-stale', REFRESH_MS * 4)).mockResolvedValue('B-fresh');
    mount(fetch);

    await wait(REFRESH_MS * 8);

    expect(rendered[0]).toBe('A-stale'); // the slow poll landed first, on its own
    expect(rendered).toContain('B-fresh');
    // The unguarded interleaving — B-fresh followed by the stale A — cannot occur.
    expect(rendered.slice(rendered.indexOf('B-fresh'))).not.toContain('A-stale');
  });

  it('stamps freshness with when the data was measured, not when it arrived', async () => {
    // A poll that took 3s did not measure "just now" — it measured 3s ago, and
    // that is what the operator must be told the moment it lands. (Later ticks
    // hang, so nothing else can re-stamp freshness under the assertion.)
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => slow('A', 3_000))
      .mockImplementation(() => new Promise(() => {}));
    const { lastFrame } = mount(fetch);

    await wait(3_200);
    expect(lastFrame() ?? '').toMatch(/freshness=updated [23]s ago/);
    expect(lastFrame() ?? '').not.toContain('updated just now');
  }, 10_000);

  it('reports no freshness at all until a poll has actually succeeded', async () => {
    const { lastFrame } = mount(() => new Promise(() => {}));
    await wait(REFRESH_MS);
    expect(lastFrame() ?? '').toContain('freshness=not updated yet');
  });

  it('surfaces a rejection, then clears it on the next good poll', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED')).mockResolvedValue('A');
    const { lastFrame } = mount(fetch);
    await wait(REFRESH_MS / 2);
    expect(lastFrame() ?? '').toContain('error=connect ECONNREFUSED');
    await wait(REFRESH_MS * 2);
    expect(lastFrame() ?? '').toContain('data=A');
    expect(lastFrame() ?? '').toContain('error=-');
  });

  it('stops polling once the view unmounts (the hub unmounts on every Esc)', async () => {
    const fetch = vi.fn().mockResolvedValue('A');
    const { unmount } = mount(fetch);
    await wait(REFRESH_MS / 2);
    const callsAtUnmount = fetch.mock.calls.length;
    unmount();
    await wait(REFRESH_MS * 3);
    expect(fetch.mock.calls.length).toBe(callsAtUnmount);
  });
});

/**
 * The post-kill refresh (final review, Finding 2).
 *
 * `refresh()` is what the kill path calls the instant the operator confirms. It
 * used to go through the same pure-SKIP guard as an interval tick, so a
 * scheduled poll that happened to be in flight silently swallowed it — and that
 * in-flight poll STARTED BEFORE THE KILL, so it lands with pre-kill data. The
 * bar says "✓ terminated pid 8801" while the killed row is still on screen, for
 * up to a full interval, at the one moment the operator most needs the screen and
 * the bar to agree.
 *
 * The fix is scoped to `refresh()` alone: an OPERATOR-requested poll is re-armed
 * (single slot — at most one queued), while an INTERVAL tick during a slow poll
 * is still simply dropped. That keeps C2 exactly as it was: pgops cannot multiply
 * its own query load on a struggling database, because nothing the clock does can
 * queue work. Only a human pressing `y` can, and only one poll deep.
 */
describe('usePoll — post-kill refresh', () => {
  /**
   * A LONG cadence (1s) and a SHORT in-flight poll (200ms). This is what makes
   * the assertion mean something: any fetch observed at t≈400ms can only have
   * come from the re-armed refresh, because the next interval tick is not due
   * until t=1000ms. (With a slow poll that outlives several ticks, the interval
   * fires the moment the poll lands and masks the dropped refresh entirely —
   * the bug hides behind the very cadence whose length is the problem.)
   */
  const SLOW_CADENCE = 1_000;
  const IN_FLIGHT = 200;

  it('re-polls after a kill even if a poll was already in flight (not silently dropped)', async () => {
    // The poll in flight when `y` is pressed started BEFORE the kill: its payload
    // is pre-kill by construction. The operator must still get a post-kill fetch.
    const fetch = vi.fn().mockReturnValueOnce(slow('pre-kill', IN_FLIGHT)).mockResolvedValue('post-kill');
    const { refresh } = mount(fetch, { refreshMs: SLOW_CADENCE });

    await wait(IN_FLIGHT / 4); // the slow, pre-kill poll is in flight
    expect(fetch).toHaveBeenCalledTimes(1);

    refresh(); // the operator confirms the kill

    // Re-armed, NOT run concurrently: the in-flight guard still holds, so the
    // refresh does not add a second query on top of the one already running.
    expect(fetch).toHaveBeenCalledTimes(1);

    // It must fire as soon as the in-flight poll lands — NOT a full cadence later
    // (t=1000), which is the window the operator spent staring at a killed row
    // under a status bar that said "✓ terminated".
    await wait(IN_FLIGHT);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(rendered).toEqual(['pre-kill', 'post-kill']);
  });

  it('coalesces a burst of refreshes into ONE follow-up poll (single slot)', async () => {
    const fetch = vi.fn().mockReturnValueOnce(slow('pre-kill', IN_FLIGHT)).mockResolvedValue('post-kill');
    const { refresh } = mount(fetch, { refreshMs: SLOW_CADENCE });

    await wait(IN_FLIGHT / 4);
    for (let i = 0; i < 10; i++) refresh();

    await wait(IN_FLIGHT);
    // One in-flight poll + exactly one re-armed poll. Ten confirmations cannot
    // become ten queries.
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT queue interval ticks — a clock tick during a slow poll is still dropped (C2)', async () => {
    // The guarantee the in-flight guard exists for, and the reason the re-arm is
    // scoped to refresh() alone. 100ms cadence, 520ms poll: four ticks are
    // skipped, and when the poll lands there must be NO catch-up burst — the next
    // fetch waits for the next interval boundary. Nothing the CLOCK does may
    // queue work; only a human pressing `y` may, and only one poll deep.
    const fetch = vi.fn().mockReturnValueOnce(slow('A', 520)).mockResolvedValue('B');
    mount(fetch, { refreshMs: 100 });

    await wait(400); // ticks at 100/200/300/400 all fall inside the slow poll
    expect(fetch).toHaveBeenCalledTimes(1);

    // The poll resolves at ~520ms. Look at ~560ms — before the next interval
    // boundary at 600ms. A queued/re-armed interval tick would show up here.
    await wait(160);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a refresh queued before unmount never fetches after unmount', async () => {
    const fetch = vi.fn().mockReturnValueOnce(slow('A', IN_FLIGHT)).mockResolvedValue('B');
    const { refresh, unmount } = mount(fetch, { refreshMs: SLOW_CADENCE });
    await wait(IN_FLIGHT / 4);
    refresh();
    unmount();
    await wait(IN_FLIGHT * 3);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
