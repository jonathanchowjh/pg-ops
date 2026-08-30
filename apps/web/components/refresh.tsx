'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
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
): { state: TickState; act: 'skip' | 'refresh' } {
  const before: TickState = { ...state, inFlight };
  return { state: onTick(before, now), act: nextTick(before, now).act };
}

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

  useEffect(() => {
    const id = setInterval(() => {
      // Every transition goes through the pure functions above, so the
      // properties they are tested for are the properties this actually has.
      // The earlier version inlined them here, where nothing could test them.
      const t = tick(state.current, Date.now(), pending.current);
      state.current = t.state;
      if (t.act === 'skip') return;

      setStartedAt(t.state.startedAt);
      startTransition(() => { router.refresh(); });
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, router]);

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
    startTransition(() => { router.refresh(); });
  }, [isPending, router]);

  return (
    <span className="text-sm text-muted-foreground" suppressHydrationWarning>
      {startedAt === null ? 'live' : `updated ${Math.round((Date.now() - startedAt) / 1000)}s ago`}
    </span>
  );
}
