'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export interface TickState {
  inFlight: boolean;
  /** An operator asked for a refresh while one was already running. */
  requested: boolean;
  /** When the in-flight refresh STARTED. Freshness is stamped here, not on arrival. */
  startedAt: number | null;
}

export type TickDecision = { act: 'skip' } | { act: 'refresh' };

/**
 * How far the reader may scroll before the poll holds.
 *
 * Not zero: a trackpad resting against a page reports one or two pixels of
 * travel that nobody intended, and holding the poll for that would be a
 * console that stops updating because someone breathed on it.
 */
export const HOLD_ABOVE_PX = 8;

/**
 * Whether a tick should HOLD because the operator has scrolled away from the
 * top of the page.
 *
 * THE POLL MOVES THE PAGE UNDER THE READER, and that is what this is for.
 * Every five seconds the server re-renders, and the height of these pages is
 * the height of their content by design — sessions come and go, and a check
 * that flips `ok` to `warn` grows from a one-line row into a full card (see
 * check-panel.tsx). When the document shrinks below `scrollY + innerHeight`
 * the browser clamps the scroll position, which reads exactly as the page
 * springing back up while you are trying to read the bottom of it.
 *
 * At the TOP there is nothing to lose: content changing below the fold moves
 * nothing the reader is looking at, so the poll runs. Once they have scrolled
 * to read, nothing should move under them at all.
 *
 * The answer is NOT to pin the heights. Content decides how tall it is —
 * reserving space for rows that may not exist would put dead air on every
 * page to protect a poll from itself.
 */
export function shouldHold(scrollY: number): boolean {
  return scrollY > HOLD_ABOVE_PX;
}

/**
 * The three properties this carries forward from the TUI's usePoll.ts:
 *
 *  1. A tick that lands while one is in flight is SKIPPED, not queued — so the
 *     tool cannot add load to the database it is diagnosing.
 *  2. Freshness is stamped at request START, not at response. A 5s fetch reads
 *     "updated 5s ago" the moment it lands, which is true. Stamping on arrival
 *     would claim "0s ago" for data that is already five seconds stale.
 *  3. An operator-requested refresh is re-armed into a single slot, so the
 *     refresh fired after an action cannot be swallowed by one that started
 *     before it.
 *
 * Pure, so all three are testable without fake timers or a mocked router.
 */
export function nextTick(state: TickState, _now: number): TickDecision {
  if (state.inFlight) return { act: 'skip' };
  return { act: 'refresh' };
}

/**
 * The STATE transition for a tick, beside `nextTick`'s decision.
 *
 * `nextTick` alone could not carry property 3: it branches on `inFlight` only,
 * so a test asserting "a requested refresh still refreshes" passed for the
 * same reason as "an idle ticker refreshes" — vacuously, and it would have
 * passed identically with `requested: false`. The re-arm lived only in the
 * component's imperative effect, where nothing tested it.
 *
 * Splitting the transition out fixes that: skipping RECORDS the missed tick
 * (property 3's first half) and starting stamps `startedAt` at the beginning
 * of the work (property 2), both as pure data.
 */
export function onTick(state: TickState, now: number): TickState {
  if (state.inFlight) return { ...state, requested: true };
  return { inFlight: true, requested: false, startedAt: now };
}

/**
 * Property 3's second half: when a refresh settles, a tick that was skipped
 * during it fires exactly ONE follow-up, and the flag clears. Without this,
 * the refresh an operator triggered after an action can be swallowed by one
 * that started before it, and the page shows pre-action data — which reads as
 * the action having done nothing. N requests during one flight collapse to a
 * single re-arm, not N, because `requested` is a flag and not a counter.
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
 *
 * I2 (final review): this is the join that was missing. `nextTick`, `onTick`
 * and `onSettle` were each tested and each correct, but the component fed them
 * an `inFlight` of its own invention: it ended the flight in
 * `setTimeout(…, 0)`, one macrotask after a fire-and-forget `router.refresh()`,
 * against a 5000 ms interval. So `inFlight` was false at every tick, forever,
 * and the branches those three functions were tested for were branches
 * production never reached. Simulated with a server render taking five
 * intervals: 10 refreshes issued, 0 ticks skipped, 5 concurrent server renders
 * — on the triage page, 5 × 8 = 40 in-flight queries against a database
 * already too slow to answer within one interval. Spec §6.3's property 1
 * exists verbatim "so the tool cannot add load to the database it is
 * diagnosing"; what shipped produced exactly the load it forbids.
 *
 * Taking `inFlight` as a parameter is what makes the loop the component runs
 * the same loop a test can drive — see refresh.test.ts, which replays that
 * simulation and now gets 8 of 10 ticks skipped and a peak concurrency of 1.
 */
export function tick(
  state: TickState,
  now: number,
  inFlight: boolean,
  holding = false,
): { state: TickState; act: 'skip' | 'refresh' | 'hold' } {
  // A HELD TICK IS NOT A MISSED ONE, so the state does not move. `skip`
  // records itself (property 3) because it was beaten to the database by a
  // flight and something is owed a follow-up; a hold is the operator
  // reading, and owes nothing. Re-arming here would fire a refresh — and
  // move the page — the moment they scrolled back to the top.
  if (holding) return { state, act: 'hold' };
  const before: TickState = { ...state, inFlight };
  return { state: onTick(before, now), act: nextTick(before, now).act };
}

/**
 * The freshness readout, the poll, and the one control that lets an operator
 * ask for data NOW.
 *
 * That control is not a nicety. `onSettle`'s re-arm exists, in its own words,
 * "so the refresh fired after an action cannot be swallowed by one that
 * started before it" — an action being a terminate. But `requested` could
 * only ever be set by a TIMER tick colliding with a flight: there was no
 * operator-facing control anywhere in the console that could request a
 * refresh, so the branch that property 3 is about was unreachable by the
 * person it was written for. The button below is that missing caller, and it
 * goes through the same `tick` the interval does rather than calling
 * `router.refresh()` directly — routing it around the state machine is what
 * would let a manual press add the concurrent load property 1 forbids.
 */
export function Refresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();
  // `isPending` IS the completion signal. It goes true when the transition
  // starts and stays true until the refreshed server render has been received
  // and committed — which is precisely "the refresh is in flight". The comment
  // that used to sit below claimed Next exposes no such signal; it does, and
  // reaching for a timer instead is what made property 1 vacuous (see `tick`).
  const [isPending, startTransition] = useTransition();
  const state = useRef<TickState>({ inFlight: false, requested: false, startedAt: null });
  // Mirrors `isPending` for the interval callback, which is created once (its
  // effect depends only on intervalMs/router) and would otherwise close over
  // the value `isPending` had on the render that started it.
  const pending = useRef(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Read in the interval callback, which is created once — a piece of state
  // would be the value it had on the render that started the interval.
  const scrollY = useRef(0);
  const [holding, setHolding] = useState(false);
  // The displayed age has to advance on its own. It was computed as
  // `Date.now() - startedAt` during render, and this component only renders
  // when a refresh starts or settles — so between polls the number was
  // frozen, and it read "updated 0s ago" almost permanently. The one moment
  // the readout genuinely matters is when the poll has STALLED, and a frozen
  // clock is precisely the display that cannot show that.
  const [now, setNow] = useState(() => Date.now());

  // Deliberately separate from the poll interval and deliberately not derived
  // from it: this drives the clock, not the fetch. Ticking the display at 1s
  // while polling at 5s is what makes a stalled poll visible as a number that
  // keeps climbing past the interval.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // One transition, whether it came from the interval or from the operator.
  // Both go through `tick`, so both obey property 1 (skip, never queue) and
  // both record property 3's re-arm on a collision.
  const request = useCallback((force = false) => {
    const t = tick(state.current, Date.now(), pending.current,
      !force && shouldHold(scrollY.current));
    state.current = t.state;
    if (t.act === 'hold') { setHolding(true); return; }
    setHolding(false);
    if (t.act === 'skip') return;

    setStartedAt(t.state.startedAt);
    setNow(Date.now());
    startTransition(() => { router.refresh(); });
  }, [router]);

  // Passive, and it only writes a ref: this fires on every frame of a scroll,
  // and re-rendering the whole page from it would be its own jank.
  useEffect(() => {
    const onScroll = () => { scrollY.current = window.scrollY; };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const id = setInterval(() => request(), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, request]);

  // The falling edge of `isPending` is the flight settling, which is where
  // property 3's re-arm belongs: a tick skipped during the flight fires
  // exactly one follow-up. Under the old timer this branch was dead code —
  // `requested` could only be set by the skip branch, which never ran.
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

  // Age is measured from request START, not arrival (property 2), so it keeps
  // climbing during a flight — which is true: the data on screen really is
  // that old until the new render commits.
  const age = startedAt === null ? null : Math.max(0, Math.round((now - startedAt) / 1000));

  return (
    <span className="flex items-center gap-3 text-sm text-muted-foreground">
      {/* A HELD POLL SAYS SO. The age keeps climbing either way — it is the
          one number that must never lie — and the clause beside it is the
          difference between a console that is stale and one that is stale
          ON PURPOSE. Without it, holding the poll would look exactly like
          the poll being broken. */}
      <span suppressHydrationWarning>
        {isPending
          ? 'refreshing…'
          : age === null
            // Before the first tick there is no age to state. "live" is a
            // claim about the poll being armed, which is all that is true yet.
            ? (holding ? 'holding while you read' : 'live')
            : `updated ${age}s ago${holding ? ' · holding while you read' : ''}`}
      </span>
      <button
        type="button"
        // FORCES THROUGH A HOLD. The hold exists so the page does not move
        // under a reader who did not ask for it; pressing this IS asking.
        onClick={() => request(true)}
        // NOT disabled while pending. A press during a flight is exactly the
        // case property 3 handles — it re-arms one follow-up rather than
        // being dropped — and disabling the control would delete the only
        // path that reaches it.
        className="rounded border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        Refresh
      </button>
    </span>
  );
}
