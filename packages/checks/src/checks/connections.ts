import type { Check } from '../types.js';
import { anyClient } from './shared.js';

export interface ConnectionsRow {
  /**
   * All three columns are cast `::int`, which node-pg returns as a JS
   * `number`. A bigint column arrives as a string and is typed `string`.
   */
  max_connections: number;
  reserved: number;
  used: number;
}

export interface ConnectionsData {
  max: number;
  used: number;
  /** superuser_reserved_connections + reserved_connections. */
  reserved: number;
  /** What an ordinary application role can still open. */
  headroom: number;
}

/**
 * Headroom subtracts superuser_reserved_connections and, on PG16+,
 * reserved_connections: an application role cannot draw from either.
 *
 * `current_setting(_, true)` is missing_ok: reserved_connections does not
 * exist below PG16, and the NULL it returns there is folded to 0 in SQL, so
 * one statement runs on every supported version.
 *
 * Client backends only: pg_stat_activity also lists auxiliary processes
 * (checkpointer, walwriter, archiver), which do not draw from the
 * max_connections pool. A client this role cannot read is counted too, or a
 * role without pg_read_all_stats would see headroom the application has
 * already taken.
 */
const SQL = `
SELECT current_setting('max_connections')::int AS max_connections,
       current_setting('superuser_reserved_connections')::int
         + COALESCE(NULLIF(current_setting('reserved_connections', true), '')::int, 0) AS reserved,
       (SELECT count(*)::int FROM pg_stat_activity
         WHERE ${anyClient()}) AS used`;

export const connections: Check<ConnectionsRow, ConnectionsData> = {
  id: 'connections',
  home: 'server',
  class: 'live',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    const max = r?.max_connections ?? 0;
    const used = r?.used ?? 0;
    const reserved = r?.reserved ?? 0;
    return { max, used, reserved, headroom: max - reserved - used };
  },
  thresholds: [
    { level: 'warn', value: 20,
      because: 'below a fifth of the pool free, a normal traffic spike can exhaust it '
             + 'before anyone reacts' },
    { level: 'critical', value: 10,
      because: 'below a tenth, connection refusals are minutes away and the fix '
             + '(pgbouncer, or killing idle-in-transaction) takes longer than that' },
  ],
};

export interface ConnectionDetailOpts { limit?: number }

export interface ConnectionDetailRow {
  pid: number;
  /** NULL for auxiliary backends, which have no database. */
  database: string | null;
  user: string | null;
  /** `application_name`; empty string when the client never set one. */
  source: string | null;
  /** NULL for unix-socket connections and when unreadable; see `sslStatus`. */
  ip: string | null;
  state: string | null;
  /** NULL when pg_stat_ssl has no row for this backend: "we could not look". */
  ssl: boolean | null;
  /** Pre-LIMIT count, carried on every row. Cast `::int` in SQL. */
  total_matching: number;
}

type SslStatus = 'SSL' | 'No SSL' | 'Socket' | 'Internal Process' | 'Unknown';

interface ConnectionSource {
  database: string | null;
  user: string | null;
  source: string | null;
  ip: string | null;
  connections: number;
  /**
   * The grouping key `map` computes, usable as a React list key. Each field
   * is `JSON.stringify`'d so an `application_name` of the text `null` cannot
   * collide with a NULL field.
   */
  key: string;
}

export interface ConnectionDetailData {
  connections: ConnectionDetailRow[];
  sources: ConnectionSource[];
  bySslStatus: Partial<Record<SslStatus, number>>;
  /** Pre-LIMIT total. Read this, never `connections.length`. */
  total: number;
  truncated: boolean;
}

/**
 * pgHero's classification, plus `'Unknown'`:
 *
 *  - no database → an auxiliary process (checkpointer, walwriter, autovacuum
 *    launcher), not an unencrypted client.
 *  - no ip, known state → a unix socket. Takes priority over `'Unknown'`.
 *  - `ssl` NULL → `pg_stat_ssl` had no row: `'Unknown'`, never `'No SSL'`
 *    and never encrypted.
 *  - `ssl` false → `'No SSL'`, a measured finding.
 */
export function sslStatus(row: ConnectionDetailRow): SslStatus {
  if (row.ssl === true) return 'SSL';
  if (!row.database) return 'Internal Process';
  if (row.ip === null && row.state !== null) return 'Socket';
  if (row.ssl === null) return 'Unknown';
  return 'No SSL';
}

/**
 * One query backs the list, the sources and the SSL breakdown, so all three
 * come from one snapshot and the source counts sum to the list.
 *
 * `count(*) OVER ()` carries the pre-LIMIT total on every row: window
 * functions are evaluated before LIMIT.
 */
const DETAIL_SQL = `
SELECT a.pid,
       a.datname       AS database,
       a.usename       AS "user",
       a.application_name AS source,
       host(a.client_addr) AS ip,
       a.state,
       s.ssl,
       count(*) OVER ()::int AS total_matching
FROM pg_stat_activity a
LEFT JOIN pg_stat_ssl s ON s.pid = a.pid
ORDER BY a.pid
LIMIT $1`;

export const connectionDetail: Check<ConnectionDetailRow, ConnectionDetailData, ConnectionDetailOpts> = {
  id: 'connectionDetail',
  home: 'server',
  class: 'live',
  sql: (o) => ({ text: DETAIL_SQL, values: [o.limit ?? 500] }),
  map: (rows) => {
    const bySslStatus: Partial<Record<SslStatus, number>> = {};
    const sourceIndex = new Map<string, ConnectionSource>();
    for (const r of rows) {
      const status = sslStatus(r);
      bySslStatus[status] = (bySslStatus[status] ?? 0) + 1;
      // `\0`-joined: `application_name` commonly contains `/`.
      const key = [r.database, r.user, r.source, r.ip].map((v) => JSON.stringify(v)).join('\0');
      const existing = sourceIndex.get(key);
      if (existing) existing.connections += 1;
      else sourceIndex.set(key, {
        database: r.database, user: r.user, source: r.source, ip: r.ip, connections: 1, key,
      });
    }
    const total = rows[0]?.total_matching ?? 0;
    return {
      connections: rows,
      sources: [...sourceIndex.values()],
      bySslStatus,
      total,
      truncated: total > rows.length,
    };
  },
};
