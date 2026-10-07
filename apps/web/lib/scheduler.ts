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

/**
 * The health cadence. One row per database per minute, which is the
 * resolution the Health pages chart at for ninety days.
 */
export const HEALTH_INTERVAL_MS = 60_000;

/**
 * A pass over every database that takes longer than this is logged. It is
 * half the interval: past it, the next tick is at risk of being skipped and
 * the charts start losing minutes for a reason nobody can see on screen.
 */
export const HEALTH_SLOW_PASS_MS = 30_000;

export interface SchedulerDeps {
  store: Pool | null;
  names: () => string[];
  capture: (name: string) => Promise<unknown>;
  /** Optional so the capture tests need not supply one. instrumentation.ts always does; a guard test holds it to that. */
  health?: (name: string) => Promise<unknown>;
  migrate: (store: Pool) => Promise<number>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let starting = false;
let running = false;
let healthTimer: ReturnType<typeof setInterval> | null = null;
/** Separate from `running`: a slow five-minute capture must not cost the health charts their minutes. */
let healthRunning = false;
/** The last failure logged per database, so an outage is one line and not one a minute. */
const HEALTH_FAILED = new Map<string, string>();
/** The parts last logged as unreadable per database, for the same reason. */
const HEALTH_PARTIAL = new Map<string, string>();
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
  if (deps.health) {
    healthTimer = setInterval(() => { void healthTick(deps); }, HEALTH_INTERVAL_MS);
    healthTimer.unref?.();
    void healthTick(deps);
  }
  return true;
}

export function stopScheduler(): void {
  generation += 1;
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (healthTimer !== null) clearInterval(healthTimer);
  healthTimer = null;
  HEALTH_FAILED.clear();
  HEALTH_PARTIAL.clear();
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

/**
 * One health pass over every configured database, in series.
 *
 * The same three rules as `tick`: serial so pgops is never many connections
 * wide, skipped rather than queued when the previous pass is still running,
 * and every error swallowed because a timer has no caller to reject to.
 *
 * What differs is the logging. This runs 1,440 times a day, so a database
 * that is down would write 1,440 identical lines; it logs the failure when
 * it starts or changes, and the recovery once.
 */
async function healthTick(deps: SchedulerDeps): Promise<void> {
  if (healthRunning || !deps.health) return;
  healthRunning = true;
  const started = Date.now();
  let count = 0;
  try {
    for (const name of deps.names()) {
      count += 1;
      let failure: string | null = null;
      try {
        const outcome = (await deps.health(name)) as
          { ok?: unknown; message?: string; missing?: string[] } | null;
        if (outcome?.ok === false) failure = outcome.message ?? 'failed';
        // A row with a part missing still lands, so it is not a failure; but
        // a part that fails every minute leaves its charts blank for ever,
        // and this is the only place that can say which and since when.
        if (outcome?.ok === true) {
          const partial = (outcome.missing ?? []).join(', ');
          const lastPartial = HEALTH_PARTIAL.get(name) ?? '';
          if (partial !== '' && partial !== lastPartial) {
            console.warn('[pgops] health for %s could not read: %s', name, partial);
          }
          if (partial === '' && lastPartial !== '') {
            console.info('[pgops] health for %s reads every part again', name);
          }
          if (partial === '') HEALTH_PARTIAL.delete(name);
          else HEALTH_PARTIAL.set(name, partial);
        }
      } catch (err) {
        failure = (err as Error)?.message ?? String(err);
      }
      const last = HEALTH_FAILED.get(name) ?? null;
      if (failure !== null && failure !== last) {
        console.error('[pgops] health capture failed for %s: %s', name, failure);
      }
      if (failure === null && last !== null) {
        console.info('[pgops] health capture recovered for %s', name);
      }
      if (failure === null) HEALTH_FAILED.delete(name);
      else HEALTH_FAILED.set(name, failure);
    }
  } finally {
    const took = Date.now() - started;
    if (took > HEALTH_SLOW_PASS_MS) {
      console.warn('[pgops] health pass took %ds across %d databases', Math.round(took / 1000), count);
    }
    healthRunning = false;
  }
}
