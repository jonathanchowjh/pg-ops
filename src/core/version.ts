import { query } from './connection.js';

/**
 * Server version detection (plan §F, Postgres version matrix).
 *
 * Queries differ across majors — `pg_wal_lsn_diff` vs `pg_xlog_location_diff`,
 * `total_exec_time` vs `total_time`. Detect once at connect, then route to the
 * right query variant. CI targets PG 13–18.
 */
export interface ServerVersion {
  /** Numeric server version, e.g. 170004 for 17.4. */
  num: number;
  /** Major version, e.g. 17. */
  major: number;
  /** Full version string from `version()`. */
  full: string;
}

let cached: ServerVersion | undefined;

export async function getServerVersion(): Promise<ServerVersion> {
  if (cached) return cached;

  const rows = await query<{ server_version_num: string; version: string }>(
    'SELECT current_setting($1) AS server_version_num, version() AS version',
    ['server_version_num'],
  );

  const row = rows[0];
  if (!row) {
    throw new Error('Could not determine Postgres server version.');
  }

  const num = Number.parseInt(row.server_version_num, 10);
  cached = {
    num,
    major: Math.floor(num / 10000),
    full: row.version,
  };
  return cached;
}
