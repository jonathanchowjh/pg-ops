import type { Check } from '../types.js';

/**
 * #56, and §3's divergence: pgHero's `fetch_settings` issues one
 * `SHOW <name>` per setting — twenty-one round trips for a page that renders
 * one table. This reads them in one.
 *
 * `current_setting(name)`, not `setting`, and that choice is the whole
 * correctness argument. For `shared_buffers`, `pg_settings` holds
 * `setting = '16384'` and `unit = '8kB'`; `SHOW shared_buffers` — what pgHero
 * renders — is `128MB`. A port that reads `setting` reports a number 8192
 * times too small, and one that concatenates the pair reports `16384 8kB`,
 * which is not a value an operator can paste into postgresql.conf.
 * `current_setting(name)` is the SHOW-equivalent, so the value is
 * self-describing and there is no separate `unit` field to render, drift from,
 * or accidentally join with a trailing space.
 *
 * No `ORDER BY`. The catalog's own order is meaningless here and `ORDER BY
 * name` would be worse — it scatters the memory settings among the planner
 * ones. `map` orders by the arrays below, which are pgHero's groups in
 * pgHero's order. Do not "fix" this by sorting in SQL.
 *
 * `WHERE name = ANY($1)` is BANDWIDTH, not correctness, and it is worth being
 * honest about that rather than leaving a reader to assume a test covers it:
 * `map` groups by membership in the arrays below, so the same three groups
 * come out whether the server sends 21 rows or all 363 of them (measured on
 * 17.11). `current_setting` over every row does not fail for an unprivileged
 * role either — also measured. The filter earns its place by not shipping
 * seventeen times the rows for a table that renders twenty-one.
 */
const SETTINGS_SQL = `
SELECT name, current_setting(name) AS value
FROM pg_settings
WHERE name = ANY($1)`;

/**
 * pgHero's main group, in pgHero's order, `io_method` in pgHero's position.
 *
 * The array is the presentation order, and it carries `io_method`
 * unconditionally — see `settingNames` below for why there is no branch.
 */
const MAIN = [
  'max_connections', 'shared_buffers', 'effective_cache_size', 'maintenance_work_mem',
  'checkpoint_completion_target', 'wal_buffers', 'default_statistics_target',
  'random_page_cost', 'effective_io_concurrency', 'work_mem', 'huge_pages',
  'jit', 'wal_compression', 'io_method', 'min_wal_size', 'max_wal_size',
];

const AUTOVACUUM = [
  'autovacuum', 'autovacuum_max_workers', 'autovacuum_vacuum_cost_limit',
  'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor',
];

const VACUUM = ['vacuum_cost_limit'];

/**
 * Every name, on every version — pgHero's version branch is NOT mirrored,
 * and that is a correction rather than a simplification.
 *
 * pgHero branches on `server_version_num` because `fetch_settings` issues
 * `SHOW <name>`, and `SHOW` ERRORS on a setting the server does not have.
 * `pg_settings` does not: a name that is not there yields no row. Verified on
 * both sides — `io_method` returns nothing on 17.11 and `worker` on 18.0.6,
 * neither an error. The branch is a workaround for a limitation this query
 * does not have.
 *
 * It also cost the check an `Opts` that no caller could supply. `sql` is a
 * pure function of its opts and cannot reach `CheckContext`, where the
 * version lives; `runCheckFor` deliberately hands a page a result and not a
 * context, and lib/check.ts's docblock forbids a page reaching past it to
 * `contextFor`. So `{ serverVersion: number }` could only have been filled by
 * re-deriving the number from `identity`'s DISPLAY string — which is a
 * different value, and the one thing the plan itself warns against.
 *
 * `map` groups by membership and skips a name with no row, so the version
 * difference is absorbed where it costs nothing. The integration test states
 * it as a property rather than carving out an exception: every name must
 * exist on every supported server, except `io_method` below 18.
 */
export function settingNames(): string[] {
  return [...MAIN, ...AUTOVACUUM, ...VACUUM];
}

export interface SettingRow { name: string; value: string }

export interface Setting { name: string; value: string }

export interface SettingsData {
  main: Setting[];
  autovacuum: Setting[];
  vacuum: Setting[];
}

/**
 * Group by membership, ordered by the arrays rather than by the rows.
 *
 * A name with no row is skipped rather than rendered blank — which is what
 * makes this function independent of the server version: on 17 there is no
 * `io_method` row, and nothing here needs to know why.
 */
function group(names: string[], byName: Map<string, string>): Setting[] {
  const out: Setting[] = [];
  for (const name of names) {
    const value = byName.get(name);
    if (value !== undefined) out.push({ name, value });
  }
  return out;
}

export function toSettings(rows: SettingRow[]): SettingsData {
  const byName = new Map(rows.map((r) => [r.name, r.value]));
  return {
    main: group(MAIN, byName),
    autovacuum: group(AUTOVACUUM, byName),
    vacuum: group(VACUUM, byName),
  };
}

export const settings: Check<SettingRow, SettingsData> = {
  id: 'settings',
  title: 'Settings',
  /**
   * `server`, not a gate. `gates.ts` is explicit that server facts belong in
   * the status line under the page heading, where `identity` already puts
   * them — not in a band and not behind a tab.
   */
  gate: 'server',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: () => ({ text: SETTINGS_SQL, values: [settingNames()] }),
  map: toSettings,
  // No verdict: §2.2. pgHero's tune page offers advice on these numbers;
  // advice that does not know the machine's RAM is a guess, and §2.2 says
  // silence beats a guess.
};
