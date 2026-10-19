import type { Check } from '../types.js';

/**
 * All settings in one query.
 *
 * `current_setting(name)`, not `setting`: for `shared_buffers`, `pg_settings`
 * holds `setting = '16384'` and `unit = '8kB'`, while `current_setting`
 * gives the SHOW form, `128MB`.
 *
 * No `ORDER BY`: `map` orders by the arrays below.
 *
 * `WHERE name = ANY($1)` only saves rows; `map` would produce the same
 * groups without it.
 */
const SETTINGS_SQL = `
SELECT name, current_setting(name) AS value
FROM pg_settings
WHERE name = ANY($1)`;

/** pgHero's main group. The array is the presentation order. */
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
 * Every name, on every version. No version branch is needed: `pg_settings`
 * yields no row for a setting the server lacks (`io_method` below 18), and
 * `map` skips a name with no row.
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

/** Ordered by `names`, not by the rows. A name with no row is skipped. */
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
  /** `server`: server facts go in the status line, not in a band. */
  gate: 'server',
  home: 'server',
  class: 'live',
  timeoutMs: 10_000,
  sql: () => ({ text: SETTINGS_SQL, values: [settingNames()] }),
  map: toSettings,
  // No verdict: tuning advice that does not know the machine's RAM is a guess.
};
