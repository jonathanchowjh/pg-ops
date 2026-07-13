import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The one poll loop, shared by every view (deep-review C1/C2).
 *
 * Each of the four views used to hand-roll this: `setInterval(() => void tick(),
 * 2000)`, a `mountedRef` cancellation guard, and (in two of the four) a
 * `lastPollAt` stamp. Four copies, four different behaviours — that divergence
 * IS the bug class the final review found. One implementation, inherited by all:
 *
 * - **In-flight guard (C1/C2).** A tick that starts while the previous one is
 *   still running is SKIPPED, not queued. Without it, on the slow, contended
 *   database this tool exists for, a 5s poll started at t=0 resolves *after* the
 *   2s poll started at t=2 — overwriting fresher numbers with older ones and
 *   re-stamping them "updated just now". Skipping also caps pgops's own load:
 *   the pool is `max: 2` (core/connection.ts) but nothing throttled submission,
 *   so a slow tick used to pile another N queries onto the queue behind it.
 *
 *   The one exception is `refresh()` — an operator-requested poll, i.e. the one
 *   fired straight after a kill. It is re-armed into a single slot rather than
 *   dropped; see the note on `refresh` below. The clock still cannot queue
 *   anything, which is the whole of C2.
 *
 * - **Freshness that means something.** `lastPollAt` is stamped with the time
 *   the poll STARTED — i.e. when the database actually measured the numbers now
 *   on screen — not when the promise resolved. A poll that took 5s therefore
 *   reads "updated 5s ago" the moment it lands, which is the truth.
 *
 * - **Mount cancellation.** The hub mounts/unmounts views on every drill-in and
 *   Esc-back, so an in-flight fetch must never set state after unmount.
 *
 * - **Ageing.** A 1s re-render so the freshness label keeps ticking between
 *   polls — a poll that has stopped succeeding is exactly when it must age.
 */

export interface UsePollOptions<T> {
  /** The view's fetch. Rejections become `error`. */
  fetch: () => Promise<T>;
  /** Called with each successful poll's payload (only while mounted). */
  onData: (data: T) => void;
  /** Poll cadence, ms. */
  refreshMs: number;
  /** Map a rejection to the operator-facing message. Defaults to `err.message`. */
  mapError?: (err: unknown) => string;
  /**
   * The poll RESOLVED but measured nothing — return the error to show.
   *
   * The cockpit's `fetchTriage()` never rejects (per-panel isolation): an
   * unreachable database resolves as six `{ ok: false }` panels. When every
   * panel failed, nothing was measured, so freshness must NOT be re-stamped —
   * the label keeps ageing instead of claiming a fresh update beside a screen
   * full of `n/a`.
   */
  unmeasured?: (data: T) => string | undefined;
}

export interface Poll {
  /** When the rendered data was measured (poll start), or undefined before the first success. */
  lastPollAt: number | undefined;
  /** Current poll error, cleared by the next successful poll. */
  error: string | undefined;
  /**
   * Poll now (e.g. straight after a kill).
   *
   * If a poll is already in flight, this is QUEUED (single slot) rather than
   * skipped — see the `pendingRefreshRef` note below. Never runs concurrently
   * with the in-flight poll, and never queues more than one.
   */
  refresh: () => void;
}

export function usePoll<T>(opts: UsePollOptions<T>): Poll {
  const [lastPollAt, setLastPollAt] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [, force] = useState(0);

  // Cancellation guard — see the header comment.
  const mountedRef = useRef(true);
  // In-flight guard (C1/C2) — an INTERVAL tick is skipped, never queued.
  const inFlightRef = useRef(false);
  // ...but an OPERATOR-requested refresh() is queued, single slot. See `refresh`.
  const pendingRefreshRef = useRef(false);

  // Latest callbacks held in refs so `tick` stays stable: the interval must not
  // be torn down and rebuilt on every render (a view re-renders once a second).
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Annotated because the body refers to `tick` (to drain a queued refresh), and
  // TS cannot infer the type of a const from its own initializer.
  const tick = useCallback<() => Promise<void>>(async () => {
    // An interval tick that lands mid-poll is DROPPED, not queued. This is the
    // whole of C2: the clock can never make pgops pile queries onto a database
    // too slow to answer inside one interval.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // Stamp the measurement time, not the arrival time.
    const measuredAt = Date.now();
    try {
      const data = await optsRef.current.fetch();
      if (!mountedRef.current) return;
      optsRef.current.onData(data);
      const failure = optsRef.current.unmeasured?.(data);
      setError(failure);
      if (failure === undefined) setLastPollAt(measuredAt);
    } catch (err) {
      const { mapError } = optsRef.current;
      // A failed poll leaves `lastPollAt` alone: the last-good numbers are still
      // on screen and the label must keep ageing rather than assert freshness.
      if (mountedRef.current) setError(mapError ? mapError(err) : (err as Error).message);
    } finally {
      inFlightRef.current = false;
      // Drain the single queued refresh, if the operator asked for one while
      // this poll was running. Runs strictly AFTER this poll settled, so it
      // never overlaps it (C2) and can only ever stamp a LATER `measuredAt`
      // than the poll it follows (C1).
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        if (mountedRef.current) void tick();
      }
    }
  }, []);

  /**
   * An operator-requested poll — what the kill path calls the instant `y` is
   * confirmed. Unlike an interval tick it is NEVER silently dropped.
   *
   * It used to go through `tick`'s pure-SKIP guard, so a scheduled poll that
   * happened to be in flight swallowed it. That poll STARTED BEFORE THE KILL, so
   * it lands carrying pre-kill data: the bar reads "✓ terminated pid 8801" while
   * the killed row is still on the screen, for up to a full interval — at the one
   * moment the operator most needs the screen to agree with the bar.
   *
   * So it re-arms instead, into a SINGLE SLOT: at most one follow-up poll is ever
   * queued, and it starts only once the in-flight poll has settled. C2 is
   * untouched (the interval still cannot queue anything — a human pressing `y`
   * can, and only one poll deep), and so is C1 (the follow-up starts, and so
   * stamps its freshness, strictly after the poll it follows).
   */
  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      pendingRefreshRef.current = true;
      return;
    }
    void tick();
  }, [tick]);

  const { refreshMs } = opts;
  useEffect(() => {
    mountedRef.current = true;
    void tick();
    const pollId = setInterval(() => void tick(), refreshMs);
    // Age the freshness label between polls.
    const ageId = setInterval(() => force((n) => n + 1), 1_000);
    return () => {
      mountedRef.current = false;
      // Nothing queued may outlive the view: the hub unmounts on every Esc.
      pendingRefreshRef.current = false;
      clearInterval(pollId);
      clearInterval(ageId);
    };
  }, [tick, refreshMs]);

  return { lastPollAt, error, refresh };
}
