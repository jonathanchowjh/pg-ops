'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { usePinned } from '@/components/clock';

export interface TickState {
  inFlight: boolean;
  /** An operator asked for a refresh while one was already running. */
  requested: boolean;
  /** When the in-flight refresh started. Freshness is stamped here, not on arrival. */
  startedAt: number | null;
}

type TickDecision = { act: 'skip' } | { act: 'refresh' };

/**
 * How far the reader may scroll before the poll holds. Not zero: a resting
 * trackpad reports one or two pixels of travel that nobody intended.
 */
const HOLD_ABOVE_PX = 8;

/**
 * Whether a tick should hold because the operator has scrolled away from the
 * top of the page.
 *
 * Each poll re-renders the page, and its height is the height of its content.
 * When the document shrinks below `scrollY + innerHeight` the browser clamps
 * the scroll position, which moves the page under the reader. At the top
 * nothing the reader is looking at moves, so the poll runs.
 */
export function shouldHold(scrollY: number): boolean {
  return scrollY > HOLD_ABOVE_PX;
}

/**
 * The poll's three properties:
 *
 *  1. A tick that lands while one is in flight is skipped, not queued — so the
 *     tool cannot add load to the database it is diagnosing.
 *  2. Freshness is stamped at request start, not at response. A 5s fetch reads
 *     "updated 5s ago" the moment it lands, which is true.
 *  3. An operator-requested refresh is re-armed into a single slot, so the
 *     refresh fired after an action cannot be swallowed by one that started
 *     before it.
 */
export function nextTick(state: TickState, _now: number): TickDecision {
  if (state.inFlight) return { act: 'skip' };
  return { act: 'refresh' };
}

/**
 * The state transition for a tick, beside `nextTick`'s decision. Skipping
 * records the missed tick (property 3's first half) and starting stamps
 * `startedAt` at the beginning of the work (property 2).
 */
export function onTick(state: TickState, now: number): TickState {
  if (state.inFlight) return { ...state, requested: true };
  return { inFlight: true, requested: false, startedAt: now };
}

/**
 * Property 3's second half: when a refresh settles, a tick that was skipped
 * during it fires exactly one follow-up, and the flag clears. N requests
 * during one flight collapse to a single re-arm, because `requested` is a
 * flag and not a counter.
 */
export function onSettle(state: TickState, _now: number): { state: TickState; act: 'refresh' | 'idle' } {
  if (state.requested) {
    return { state: { ...state, inFlight: false, requested: false }, act: 'refresh' };
  }
  return { state: { ...state, inFlight: false }, act: 'idle' };
}

/**
 * One tick of the ticker, as data — the decision and the state transition
 * together, with `inFlight` supplied by the caller rather than tracked here.
 * That makes the loop the component runs the same loop refresh.test.ts
 * drives, which holds peak concurrency at 1 under a slow server render.
 */
export function tick(
  state: TickState,
  now: number,
  inFlight: boolean,
  holding = false,
): { state: TickState; act: 'skip' | 'refresh' | 'hold' } {
  // A held tick is not a missed one, so the state does not move. Re-arming
  // here would fire a refresh — and move the page — the moment the reader
  // scrolled back to the top.
  if (holding) return { state, act: 'hold' };
  const before: TickState = { ...state, inFlight };
  return { state: onTick(before, now), act: nextTick(before, now).act };
}

/**
 * The freshness readout, the poll, and the Refresh button. The button goes
 * through the same `tick` the interval does rather than calling
 * `router.refresh()` directly, so a manual press cannot add the concurrent
 * load property 1 forbids.
 */
export function Refresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();
  // `isPending` is the in-flight signal: true from the start of the
  // transition until the refreshed server render has been received and
  // committed.
  const [isPending, startTransition] = useTransition();
  const state = useRef<TickState>({ inFlight: false, requested: false, startedAt: null });
  // Mirrors `isPending` for the interval callback, which would otherwise
  // close over the value it had on the render that started the interval.
  const pending = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // A ref for the same reason: it is read in the interval callback.
  const scrollY = useRef(0);
  const [holding, setHolding] = useState(false);
  // Under a clock the page is a window of time. It holds while pinned to a
  // moment, which is the reader asking it to stand still, and never for
  // scroll: its rows are fixed within a window, so a poll moves nothing.
  // Null outside a clock, where the scroll rule stands. A ref for the same
  // reason as `scrollY`.
  const pinned = usePinned();
  const pinnedNow = useRef(pinned);
  pinnedNow.current = pinned;
  // The displayed age advances on its own clock. This component otherwise
  // renders only when a refresh starts or settles, and a stalled poll has to
  // show as a number that keeps climbing.
  const [now, setNow] = useState(() => Date.now());

  // Drives the clock, not the fetch.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // One path for the interval and the operator. Both go through `tick`, so
  // both obey property 1 and both record property 3's re-arm on a collision.
  const request = useCallback((force = false) => {
    const hold = pinnedNow.current === null ? shouldHold(scrollY.current) : pinnedNow.current;
    const t = tick(state.current, Date.now(), pending.current, !force && hold);
    state.current = t.state;
    if (t.act === 'hold') { setHolding(true); return; }
    setHolding(false);
    if (t.act === 'skip') return;

    setStartedAt(t.state.startedAt);
    setNow(Date.now());
    startTransition(() => { router.refresh(); });
  }, [router]);

  // Passive, and it only writes a ref: this fires on every frame of a scroll.
  useEffect(() => {
    const onScroll = () => { scrollY.current = window.scrollY; };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Not while the tab is hidden: each poll reads the database being
  // diagnosed, and nobody is reading the answer. Shown again, it reads once.
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') request(); }, intervalMs);
    const onShown = () => { if (document.visibilityState === 'visible') request(); };
    document.addEventListener('visibilitychange', onShown);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onShown); };
  }, [intervalMs, request]);

  // The falling edge of `isPending` is the flight settling: a tick skipped
  // during the flight fires exactly one follow-up (property 3).
  useEffect(() => {
    const was = pending.current;
    pending.current = isPending;
    if (!was || isPending) return;
    const settled = onSettle({ ...state.current, inFlight: false }, Date.now());
    state.current = settled.state;
    if (settled.act !== 'refresh') return;
    setStartedAt(Date.now());
    setNow(Date.now());
    startTransition(() => { router.refresh(); });
  }, [isPending, router]);

  // Age is measured from request start, not arrival (property 2), so it keeps
  // climbing during a flight.
  const age = startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 1000));

  const button = (
    <button
      type="button"
      // Forces through a hold.
      onClick={() => request(true)}
      // Not disabled while pending: a press during a flight re-arms one
      // follow-up (property 3) rather than being dropped.
      className="rounded border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      Refresh
    </button>
  );
  // The clock bar already says what moment the page shows, as a clock time.
  if (pinned !== null) return button;

  return (
    <span className="flex items-center gap-3 text-sm text-muted-foreground">
      {/* A held poll says so. Without the clause, holding would look like
          the poll being broken. */}
      <span suppressHydrationWarning>
        {isPending
          ? 'refreshing…'
          : age === null
            // Before the first tick there is no age to state.
            ? (holding ? 'holding while you read' : 'live')
            : `updated ${age}s ago${holding ? ' · holding while you read' : ''}`}
      </span>
      {button}
    </span>
  );
}
