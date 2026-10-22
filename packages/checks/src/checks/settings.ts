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
 *
 * A timeout pgops set on its own connection reads as pgops's, not the
 * server's: the pool's backstop and the check's `SET LOCAL` both show in
 * `current_setting`. Where this session set it, `reset_val` is what the
 * server gives everyone else, in milliseconds.
 */
const SETTINGS_SQL = `
SELECT name, current_setting(name) AS value,
       CASE WHEN source = 'session' AND unit = 'ms' THEN reset_val END AS reset_ms
FROM pg_settings
WHERE name = ANY($1)`;

/** Milliseconds as SHOW prints them: the largest unit that divides evenly, `0` when off. */
export function showMs(ms: number): string {
  if (ms === 0) return '0';
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['min', 60_000], ['s', 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/**
 * pgHero's main group, then the timeouts the pages reason about: a chain
 * nothing ends, an idle transaction nothing closes, a deadlock Postgres
 * breaks. The array is the presentation order. Server tags a timeout of 0
 * "off".
 */
const MAIN = [
  'max_connections', 'shared_buffers', 'effective_cache_size', 'maintenance_work_mem',
  'checkpoint_completion_target', 'wal_buffers', 'default_statistics_target',
  'random_page_cost', 'effective_io_concurrency', 'work_mem', 'huge_pages',
  'jit', 'wal_compression', 'io_method', 'min_wal_size', 'max_wal_size',
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'deadlock_timeout',
];

const AUTOVACUUM = [
  'autovacuum', 'autovacuum_max_workers', 'autovacuum_vacuum_cost_limit',
  'autovacuum_vacuum_scale_factor', 'autovacuum_analyze_scale_factor', 'autovacuum_freeze_max_age',
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

export interface SettingRow { name: string; value: string; reset_ms?: string | null }

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
  const byName = new Map(rows.map((r) => [r.name, r.reset_ms == null ? r.value : showMs(Number(r.reset_ms))]));
  return {
    main: group(MAIN, byName),
    autovacuum: group(AUTOVACUUM, byName),
    vacuum: group(VACUUM, byName),
  };
}

export const settings: Check<SettingRow, SettingsData> = {
  id: 'settings',
  /** `server`: a server's settings are listed on its Server page. */
  home: 'server',
  class: 'live',
  timeoutMs: 10_000,
  sql: () => ({ text: SETTINGS_SQL, values: [settingNames()] }),
  map: toSettings,
};
