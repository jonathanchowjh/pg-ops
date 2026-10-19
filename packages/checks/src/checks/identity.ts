import type { Check } from '../types.js';

export interface IdentityRow {
  database: string;
  user: string;
  server_version_num: string;
  replica: boolean;
  /** NULL when `pg_stat_ssl` has no row for this backend. */
  ssl: boolean | null;
}

export interface IdentityData {
  /** `current_database()` — the server's own name, not the operator's config label. */
  database: string | null;
  user: string | null;
  /** Display form, e.g. `17.2`. Null only if the row was missing entirely. */
  serverVersion: string | null;
  replica: boolean | null;
  /** `null` is "we could not look", distinct from `false`, "not encrypted". */
  ssl: boolean | null;
}

/**
 * Who and what we are actually connected to. Every other surface names a
 * database by the operator's label in `PGOPS_DATABASES`; this is the
 * server's own answer, so a mislabelled connection is visible.
 *
 * No verdict: none of these facts is a fault, including being a replica.
 *
 * SSL comes from `pg_stat_ssl`, a core view, not pgHero's `ssl_is_used()`,
 * which needs the `sslinfo` extension. Our own backend's row is readable
 * without `pg_read_all_stats`.
 */
const SQL = `
SELECT current_database()                     AS database,
       current_user                           AS "user",
       current_setting('server_version_num')  AS server_version_num,
       pg_is_in_recovery()                    AS replica,
       -- Scalar subquery, not a join: it yields NULL rather than dropping
       -- the whole row if pg_stat_ssl has nothing for this backend, so an
       -- unreadable SSL status costs the SSL field and not the database
       -- name beside it.
       (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`;

/**
 * `server_version_num` is major * 10000 + minor: 170002 is 17.2. The pre-10
 * scheme is not handled; the floor is 14.
 */
function formatVersion(num: string | undefined): string | null {
  if (num == null) return null;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  return `${Math.floor(n / 10000)}.${n % 10000}`;
}

export const identity: Check<IdentityRow, IdentityData> = {
  id: 'identity',
  gate: 'server',
  home: 'server',
  title: 'Connection identity',
  class: 'live',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      database: r?.database ?? null,
      user: r?.user ?? null,
      serverVersion: formatVersion(r?.server_version_num),
      // `??`, never `||`: `false` is a finding and must not become `null`.
      replica: r?.replica ?? null,
      ssl: r?.ssl ?? null,
    };
  },
};
