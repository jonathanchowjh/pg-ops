import { connection } from 'next/server';
import {
  cacheCheckPass, checkResultRow, hygieneAreas, readCheckResults,
  type CheckResult, type HygieneArea,
} from '@pgops/checks';
import { isMissingRequestStore } from './check';
import { CAPTURE_INTERVAL_MS } from './scheduler';
import { storePool } from './store';

/**
 * Two capture intervals. One would make every reading taken slightly before
 * a tick read as stale — the interval is a floor on how old a fresh reading
 * can be, not a ceiling — and anything longer would let a stopped scheduler
 * keep painting yesterday's verdict as current.
 */
export const STALE_AFTER_MS = 2 * CAPTURE_INTERVAL_MS;

export type HygieneRead =
  | { ok: true; areas: HygieneArea[] }
  | { ok: false; message: string };

/**
 * The cached hygiene findings for one database, rolled up per area.
 *
 * THIS READS THE CACHE AND NEVER RUNS A CHECK. The triage page polls every
 * five seconds; the checks behind these lines are catalog scans that take up
 * to ten seconds each. Running one here would put a scan on a five-second
 * timer against the database this console promises not to burden — which is
 * why `test/guards.test.ts` fails if the triage page's imports ever reach a
 * hygiene check's runner.
 *
 * One indexed read of `pgops.check_results`, keyed by (database_id,
 * check_id), returning one row per hygiene check — the same order of cost as
 * the queries page's since-last-capture lookup.
 *
 * Never throws, same contract as `runCheckFor`: a triage page must render a
 * lock chain even when the store is unreachable.
 */
export async function hygieneFor(name: string): Promise<HygieneRead> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `pgops console error — ${detail}` };
    }
  }

  const store = storePool(process.env);
  if (store === null) {
    // Not an error, and worded as the one action that changes it. Hygiene
    // findings are computed by the capture tick, and there is no tick
    // without a store.
    return { ok: false, message: 'History is off — set PGOPS_STORE_URL to record hygiene findings.' };
  }

  try {
    const results = await readCheckResults(store, name);
    return { ok: true, areas: hygieneAreas(results, { now: new Date(), staleAfterMs: STALE_AFTER_MS }) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}


/**
 * Cache what a hygiene page just computed, so the triage line agrees with it.
 *
 * The pages still run their checks on visit — that path is unchanged, and it
 * is what makes a page instant to trust: you are reading this database now,
 * not five minutes ago. This is the same reading, written where the triage
 * page can see it, which closes the gap pgHero fills by putting every
 * hygiene finding on its dashboard.
 *
 * Fire and forget, and awaited only for its error swallowing: with no store
 * there is nothing to write and nothing to say about it. A page must never
 * fail, or slow down, over a cache.
 */
export async function cacheChecks(
  name: string,
  results: Readonly<Record<string, CheckResult<unknown>>>,
): Promise<void> {
  const store = storePool(process.env);
  if (store === null) return;
  await cacheCheckPass(
    store,
    name,
    Object.entries(results).map(([checkId, result]) => checkResultRow(checkId, result)),
  );
}
