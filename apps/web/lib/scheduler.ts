import type { Pool } from 'pg';

/**
 * pgHero's own capture cadence. Dense enough for query-stat deltas to chart,
 * sparse enough that space stats cost nothing.
 *
 * The 15-minute hygiene tick spec §3.2 describes is NOT here: P3 ships no
 * hygiene check, so a second timer would have nothing to run. It arrives with
 * P2, alongside the checks it serves.
 */
export const CAPTURE_INTERVAL_MS = 5 * 60_000;

export interface SchedulerDeps {
  store: Pool | null;
  names: () => string[];
  capture: (name: string) => Promise<unknown>;
  migrate: (store: Pool) => Promise<number>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let starting = false;
let running = false;
/**
 * Bumped by every `stopScheduler`. A start that is mid-`migrate` when a stop
 * arrives compares this on the far side of the await and abandons rather than
 * arming a timer AFTER the stop — the same shape as the defect the `starting`
 * flag fixed, one await further along.
 */
let generation = 0;

/**
 * Start the capture timer. Returns whether it started.
 *
 * Dependencies are passed in rather than imported so this is testable with no
 * database and no Next server — the same reason `packages/checks` takes pools
 * instead of reaching for them.
 */
export async function startScheduler(deps: SchedulerDeps): Promise<boolean> {
  // No store, no scheduler, and — the part that matters — no DDL. See
  // lib/store.ts on why there is no fallback to a monitored database.
  if (deps.store === null) return false;
  // I8 (final review): `timer` alone was read BEFORE the await below and
  // written AFTER it, so two overlapping calls both passed the guard, both
  // migrated, and both setInterval'd — the first handle overwritten and lost,
  // permanently unstoppable by `stopScheduler`. `starting` is set
  // synchronously, before any await, which is what closes that window.
  if (timer !== null || starting) return true;
  starting = true;

  const startedAt = generation;
  try {
    await deps.migrate(deps.store);
  } catch (err) {
    // I1 (final review): the ONE path in this branch that did not swallow.
    // Every sibling docblock — captureOnce's, tick's, storePool's — says a
    // console that dies because a store blinked is worse than one reporting
    // history as unavailable, and this contradicted all three: Next awaits
    // register() during server preparation, so a store still coming up (an
    // ordinary compose/k8s ordering) took the whole console down with it.
    // History is off for this process; the console serves.
    console.error(
      '[pgops] store migration failed; history is disabled for this process: %s',
      (err as Error)?.message ?? err,
    );
    starting = false;
    return false;
  }

  if (generation !== startedAt) {
    // Stopped while migrating. Arming now would leave a timer running against
    // a `deps` the caller believes it has torn down.
    starting = false;
    return false;
  }
  timer = setInterval(() => { void tick(deps); }, CAPTURE_INTERVAL_MS);
  // Do not hold the process open for the sake of the timer.
  timer.unref?.();
  starting = false;
  // Capture once NOW, not in five minutes. A deployment that restarts pods
  // more often than the capture interval — a crash loop, an aggressive
  // rolling update — otherwise records nothing at all, ever, and nothing
  // says so. Not awaited: `register()` must not block the server coming up
  // on a capture, and `tick` swallows everything by contract.
  void tick(deps);
  return true;
}

export function stopScheduler(): void {
  generation += 1;
  if (timer !== null) clearInterval(timer);
  timer = null;
  starting = false;
  // `running` is deliberately NOT reset here. A tick already in flight keeps
  // its own `finally` to clear it; zeroing it from the outside would let a
  // scheduler restarted mid-tick run a second capture concurrently with the
  // first, breaking the "skipped, never queued" property this file exists for.
}

/**
 * One pass over every configured database, in series.
 *
 * SERIAL, not parallel: a diagnostic tool must not be the reason connections
 * run out, which is the same reasoning that caps `poolFor` at ten.
 *
 * SKIPPED, not queued, when the previous tick is still in flight — the rule
 * `usePoll` applies in the browser, for the same reason: the tool must never
 * add load to the database it is diagnosing.
 *
 * Every error is swallowed. This runs on a timer with no caller to reject to,
 * and an unhandled rejection in that position terminates the Node process —
 * a console that dies because the store blinked is worse than one that
 * reports history as unavailable.
 */
async function tick(deps: SchedulerDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const name of deps.names()) {
      try {
        const outcome = await deps.capture(name);
        // captureOnce reports a query-stats half it could not read WITHOUT
        // throwing — space stats still landed, so the pass is not a failure.
        // This is that report's only reader. Without it the outcome field
        // existed and nothing anywhere acted on it: a cluster whose
        // pg_stat_statements extension is older than its server records zero
        // shapes forever, logs nothing, and renders a column of em dashes an
        // operator reads as "these queries have not moved".
        const err = (outcome as { queryStatsError?: string } | null)?.queryStatsError;
        if (err !== undefined) {
          console.warn(
            '[pgops] %s: relation sizes captured, query statistics NOT: %s', name, err,
          );
        }
      } catch (err) {
        console.error('[pgops] capture failed for %s: %s', name, (err as Error)?.message ?? err);
      }
    }
  } finally {
    running = false;
  }
}
