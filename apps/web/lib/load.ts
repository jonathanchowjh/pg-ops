import { connection } from 'next/server';
import { readDatabaseSpace, readQueryLoad, readQueryText, type StoredLoad, type StoredTotal } from '@pgops/checks';
import { isMissingRequestStore } from './check';
import { storePool } from './store';

/** The window the Queries chart draws, and the capture count that fills it. */
export const LOAD_HOURS = 24;

export type LoadRead =
  | { ok: true; points: StoredLoad[] }
  | { ok: false; message: string };

/**
 * A day of this database's total work, one point per capture.
 *
 * ONE INDEXED READ OF AT MOST 288 ROWS, on a page that polls every five
 * seconds. That bound is the reason `pgops.query_load` exists at all: the
 * same chart summed from `query_stats` at read time would difference 5,000
 * shapes across 288 captures on every tick — see migration 004.
 *
 * Never throws, same contract as `runCheckFor` and `hygieneFor`: the Queries
 * page must rank statements even when the store is unreachable.
 *
 * ONE MESSAGE, and the caller may ignore it. A store that is configured and
 * failing is a different fact from no store, and the Queries page already
 * says which of the two it is — once, above the table, for the
 * since-last-capture column that reads the same store. A second sentence
 * saying it again over a missing chart would be the same failure reported
 * twice.
 */
export async function queryLoadFor(name: string): Promise<LoadRead> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `pgops console error — ${detail}` };
    }
  }

  const store = storePool(process.env);
  if (store === null) return { ok: false, message: 'History is off.' };

  try {
    const to = new Date();
    const from = new Date(to.getTime() - LOAD_HOURS * 3_600_000);
    return { ok: true, points: await readQueryLoad(store, name, from, to) };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The statement a `queryid` stands for, or `null` if it cannot be had.
 *
 * NEVER THROWS, and the null case is deliberately not distinguished from the
 * failure case by the caller: a detail page that could not fetch the text
 * falls back to the ID it already has, which is what it showed before this
 * existed. A store failure worth acting on is reported by the history read
 * right below it, so saying it twice on one page would be the same failure
 * reported twice — the same rule `queryLoadFor` states.
 */
export async function queryTextFor(name: string, queryid: string): Promise<string | null> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) return null;
  }

  const store = storePool(process.env);
  if (store === null) return null;

  try {
    return await readQueryText(store, name, queryid);
  } catch {
    return null;
  }
}

/** The window the Space page's total-size chart draws. */
export const SPACE_DAYS = 30;

/**
 * The whole database's captured size over `SPACE_DAYS`, one point per capture.
 *
 * NEVER THROWS and returns `[]` on every failure, for the same reason
 * `queryTextFor` returns null: the Space page already reports a store it
 * could not read, once, through the growth column that reads the same store.
 * A second report over a missing chart would be one failure stated twice.
 */
export async function databaseSpaceFor(name: string): Promise<StoredTotal[]> {
  try {
    await connection();
  } catch (err) {
    if (!isMissingRequestStore(err)) return [];
  }

  const store = storePool(process.env);
  if (store === null) return [];

  try {
    const to = new Date();
    const from = new Date(to.getTime() - SPACE_DAYS * 24 * 3_600_000);
    return await readDatabaseSpace(store, name, from, to);
  } catch {
    return [];
  }
}
