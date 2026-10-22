import type { Pool } from 'pg';
import { BUCKET_MS, messageOf } from '@pgops/checks';

/**
 * The capture cadence. Dense enough for query-stat deltas to chart, sparse
 * enough that space stats cost nothing.
 */
export const CAPTURE_INTERVAL_MS = 5 * 60_000;

/**
 * The health cadence. One row per database per minute: the resolution
 * Server's panels and the health row read, kept for ninety days.
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
export const SAMPLE_INTERVAL_MS = BUCKET_MS;

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

type Job = 'capture' | 'health' | 'sample' | 'place';

const TIMERS: ReturnType<typeof setInterval>[] = [];
/**
 * Passes in flight. Not reset by `stopScheduler`: a pass already running
 * clears its own entry in `finally`, and zeroing it here would let a scheduler
 * restarted mid-pass run a second one concurrently with the first.
 */
const RUNNING = new Set<Job>();
let starting = false;
/**
 * Bumped by every `stopScheduler`. A start that is mid-`migrate` when a stop
 * arrives compares this on the far side of the await and abandons rather than
 * arming a timer after the stop.
 */
let generation = 0;
/** The last failure logged per database, so an outage is one line and not one a minute. */
const HEALTH_FAILED = new Map<string, string>();
/** The parts last logged as unreadable per database, for the same reason. */
const HEALTH_PARTIAL = new Map<string, string>();

/**
 * Arm the timers `deps` can run: capture, health and placement with a store,
 * sampling with a sampler. Returns whether any was armed.
 *
 * Dependencies are passed in rather than imported so this is testable with no
 * database and no Next server.
 */
export async function startScheduler(deps: SchedulerDeps): Promise<boolean> {
  // TIMERS is filled only after the await below, so on its own it would let
  // two overlapping calls both pass this guard and arm twice, the first
  // handles lost. `starting` is set synchronously, before any await.
  if (TIMERS.length > 0 || starting) return true;
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
  // Every pass is async from its first line: a `names()` that throws rejects the pass, not `arm`.
  const { health, place, sample } = deps;
  if (history) {
    arm('capture', CAPTURE_INTERVAL_MS, () => capturePass(deps));
    if (health) arm('health', HEALTH_INTERVAL_MS, () => healthPass(deps, health));
    if (place) arm('place', PLACE_INTERVAL_MS, async () => eachAtMost(deps.names(), PASS_WIDTH, place));
  }
  if (sample) arm('sample', SAMPLE_INTERVAL_MS, async () => eachAtMost(deps.names(), PASS_WIDTH, sample));
  starting = false;
  return history || sample !== undefined;
}

export function stopScheduler(): void {
  generation += 1;
  for (const timer of TIMERS) clearInterval(timer);
  TIMERS.length = 0;
  HEALTH_FAILED.clear();
  HEALTH_PARTIAL.clear();
  starting = false;
}

/**
 * Arm one interval, and fire it once now: a deployment that restarts more
 * often than the interval would otherwise record nothing. Not awaited:
 * `register()` must not block the server coming up on a pass.
 *
 * Skipped, not queued, while the last pass is in flight: the tool must never
 * add load to the database it is diagnosing. Each job has its own flag, so a
 * slow capture costs the health charts nothing. Every error is swallowed: a
 * timer has no caller to reject to, and an unhandled rejection there ends the
 * Node process.
 */
function arm(name: Job, everyMs: number, pass: () => Promise<void>): void {
  const once = async (): Promise<void> => {
    if (RUNNING.has(name)) return;
    RUNNING.add(name);
    try {
      await pass().catch(() => {});
    } finally {
      RUNNING.delete(name);
    }
  };
  const timer = setInterval(() => { void once(); }, everyMs);
  // Do not hold the process open for the sake of the timer.
  timer.unref?.();
  TIMERS.push(timer);
  void once();
}

/**
 * Serial, not parallel (width 1): a diagnostic tool must not be the reason
 * connections run out.
 */
async function capturePass(deps: SchedulerDeps): Promise<void> {
  await eachAtMost(deps.names(), 1, async (name) => {
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
  });
}

/**
 * Serial like capture. What differs is the logging: this runs 1,440 times a
 * day, so a database that is down would write 1,440 identical lines; it logs
 * the failure when it starts or changes, and the recovery once.
 */
async function healthPass(deps: SchedulerDeps, health: (name: string) => Promise<unknown>): Promise<void> {
  const started = Date.now();
  const names = deps.names();
  try {
    await eachAtMost(names, 1, async (name) => {
      let failure: string | null = null;
      try {
        const outcome = (await health(name)) as
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
    });
  } finally {
    const took = Date.now() - started;
    if (took > HEALTH_SLOW_PASS_MS) {
      console.warn('[pgops] health pass took %ds across %d databases', Math.round(took / 1000), names.length);
    }
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
