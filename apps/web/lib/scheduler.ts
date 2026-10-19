import type { Pool } from 'pg';
import { messageOf } from '@pgops/checks';

/**
 * The capture cadence. Dense enough for query-stat deltas to chart, sparse
 * enough that space stats cost nothing.
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
 * the charts start losing minutes.
 */
export const HEALTH_SLOW_PASS_MS = 30_000;

/**
 * The sample cadence: one bucket. A tick reads only when no page's poll has
 * filled the current bucket, so with a page open it sends nothing.
 */
export const SAMPLE_INTERVAL_MS = 15_000;

/** The placement cadence. A shape is in two snapshots within ten minutes of first running; this plans it within the next. */
export const PLACE_INTERVAL_MS = 60_000;

export interface SchedulerDeps {
  store: Pool | null;
  names: () => string[];
  capture: (name: string) => Promise<unknown>;
  /** Optional so the capture tests need not supply one. instrumentation.ts always does; a guard test holds it to that. */
  health?: (name: string) => Promise<unknown>;
  migrate: (store: Pool) => Promise<number>;
  /** The sampler's turn for one database. Needs no store: without one it keeps fifteen minutes in memory. */
  sample?: (name: string) => Promise<unknown>;
  /** Plans the shapes the store's snapshots hold and no plan has placed. Runs only with a store: the shapes are the store's. */
  place?: (name: string) => Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;
let starting = false;
let running = false;
let healthTimer: ReturnType<typeof setInterval> | null = null;
/** Separate from `running`: a slow five-minute capture must not cost the health charts their minutes. */
let healthRunning = false;
let sampleTimer: ReturnType<typeof setInterval> | null = null;
/** Separate again: a sample must land every fifteen seconds whatever the capture is doing. */
let sampling = false;
let placeTimer: ReturnType<typeof setInterval> | null = null;
let placing = false;
/** The last failure logged per database, so an outage is one line and not one a minute. */
const HEALTH_FAILED = new Map<string, string>();
/** The parts last logged as unreadable per database, for the same reason. */
const HEALTH_PARTIAL = new Map<string, string>();
/**
 * Bumped by every `stopScheduler`. A start that is mid-`migrate` when a stop
 * arrives compares this on the far side of the await and abandons rather than
 * arming a timer after the stop.
 */
let generation = 0;

/**
 * Start the capture timer. Returns whether it started.
 *
 * Dependencies are passed in rather than imported so this is testable with no
 * database and no Next server.
 */
export async function startScheduler(deps: SchedulerDeps): Promise<boolean> {
  // `timer` is written only after the await below, so on its own it would
  // let two overlapping calls both pass this guard and arm two timers, the
  // first handle lost. `starting` is set synchronously, before any await.
  if (timer !== null || sampleTimer !== null || starting) return true;
  // No store and no sampler: nothing to run, and no DDL.
  if (deps.store === null && deps.sample === undefined) return false;
  starting = true;

  const startedAt = generation;
  let history = deps.store !== null;
  if (deps.store !== null) {
    try {
      await deps.migrate(deps.store);
    } catch (err) {
      // Swallowed: Next awaits register() during server preparation, so a
      // store still coming up (an ordinary compose/k8s ordering) would
      // otherwise take the whole console down with it. History is off for
      // this process; the console serves, and the sampler keeps its memory.
      console.error(
        '[pgops] store migration failed; history is disabled for this process: %s',
        messageOf(err),
      );
      history = false;
    }
  }

  if (generation !== startedAt) {
    // Stopped while migrating. Arming now would leave a timer running against
    // a `deps` the caller believes it has torn down.
    starting = false;
    return false;
  }
  if (history) {
    timer = setInterval(() => { void tick(deps); }, CAPTURE_INTERVAL_MS);
    // Do not hold the process open for the sake of the timer.
    timer.unref?.();
    // Capture once now, not in five minutes: a deployment that restarts more
    // often than the capture interval would otherwise record nothing. Not
    // awaited: `register()` must not block the server coming up on a capture,
    // and `tick` swallows everything by contract.
    void tick(deps);
    if (deps.health) {
      healthTimer = setInterval(() => { void healthTick(deps); }, HEALTH_INTERVAL_MS);
      healthTimer.unref?.();
      void healthTick(deps);
    }
    if (deps.place) {
      placeTimer = setInterval(() => { void placePass(deps); }, PLACE_INTERVAL_MS);
      placeTimer.unref?.();
      void placePass(deps);
    }
  }
  if (deps.sample) {
    sampleTimer = setInterval(() => { void samplePass(deps); }, SAMPLE_INTERVAL_MS);
    sampleTimer.unref?.();
    void samplePass(deps);
  }
  starting = false;
  return history || deps.sample !== undefined;
}

export function stopScheduler(): void {
  generation += 1;
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (healthTimer !== null) clearInterval(healthTimer);
  healthTimer = null;
  if (sampleTimer !== null) clearInterval(sampleTimer);
  sampleTimer = null;
  if (placeTimer !== null) clearInterval(placeTimer);
  placeTimer = null;
  HEALTH_FAILED.clear();
  HEALTH_PARTIAL.clear();
  starting = false;
  // `running` is deliberately not reset here. A tick already in flight clears
  // it in its own `finally`; zeroing it here would let a scheduler restarted
  // mid-tick run a second capture concurrently with the first.
}

/**
 * One pass over every configured database, in series.
 *
 * Serial, not parallel: a diagnostic tool must not be the reason connections
 * run out. Skipped, not queued, when the previous tick is still in flight:
 * the tool must never add load to the database it is diagnosing.
 *
 * Every error is swallowed. This runs on a timer with no caller to reject to,
 * and an unhandled rejection in that position terminates the Node process.
 */
async function tick(deps: SchedulerDeps): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const name of deps.names()) {
      try {
        const outcome = await deps.capture(name);
        // captureOnce reports a query-stats half it could not read without
        // throwing — space stats still landed, so the pass is not a failure.
        // This is that report's only reader.
        const err = (outcome as { queryStatsError?: string } | null)?.queryStatsError;
        if (err !== undefined) {
          console.warn(
            '[pgops] %s: relation sizes captured, query statistics NOT: %s', name, err,
          );
        }
      } catch (err) {
        console.error('[pgops] capture failed for %s: %s', name, messageOf(err));
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
        // A row with a part missing still lands, so it is not a failure; this
        // log is the only place that says which part and since when.
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
        failure = messageOf(err);
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

/**
 * One sample pass over every configured database, in series, skipped while
 * the last is running. `deps.sample` never rejects; the catch is a backstop.
 * `samplePass`, not `sampleTick`: that is the function lib/samples.ts hands
 * in as `deps.sample`.
 */
async function samplePass(deps: SchedulerDeps): Promise<void> {
  if (sampling || !deps.sample) return;
  sampling = true;
  try {
    await eachAtMost(deps.names(), PASS_WIDTH, deps.sample);
  } finally {
    sampling = false;
  }
}

/** One placement pass over every configured database, skipped while the last is running. */
async function placePass(deps: SchedulerDeps): Promise<void> {
  if (placing || !deps.place) return;
  placing = true;
  try {
    await eachAtMost(deps.names(), PASS_WIDTH, deps.place);
  } finally {
    placing = false;
  }
}

/** Databases a sample or placement pass works on at once. */
const PASS_WIDTH = 4;

/**
 * `run` over every name, at most `width` at once: a database that is slow
 * to answer holds up its own turn, not every other database's. Never
 * rejects.
 */
async function eachAtMost(names: readonly string[], width: number, run: (name: string) => Promise<unknown>): Promise<void> {
  const queue = [...names];
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    for (let name = queue.shift(); name !== undefined; name = queue.shift()) await run(name).catch(() => {});
  }));
}
