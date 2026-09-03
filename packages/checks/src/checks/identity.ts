import type { Check } from '../types.js';

export interface IdentityRow {
  database: string;
  user: string;
  server_version_num: string;
  replica: boolean;
  /** NULL when `pg_stat_ssl` has no row for this backend — see the SQL below. */
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
 * Who and what we are actually connected to. pgHero #1, #2, #3 and #48.
 *
 * This check reports and never escalates — `verdict` is deliberately absent
 * (`Check.verdict` is optional: "absent means this check reports but never
 * escalates"). None of these four facts is a fault. Being a replica is the
 * closest, and it still is not: a standby is a correct thing to be. What it
 * changes is what the operator should do next, which is why it renders as a
 * badge next to a kill button rather than as a verdict on the overview.
 *
 * Why it exists at all: every other surface in this console names a database
 * by the label the OPERATOR chose in `PGOPS_DATABASES` — `prod`, `staging`.
 * That label is an assertion about a connection string, and nothing had ever
 * checked it against the server on the other end. A copied config entry, a
 * stale port-forward, or a `PGOPS_CONFIG_FILE` edited in the wrong container
 * all produce a page headed `prod` that is talking to something else. The
 * page has a terminate button on it.
 *
 * DIVERGENCE FROM pgHero (#3), in the style of ops-console spec §3.4:
 * pgHero's `ssl_used?` calls `ssl_is_used()`, which comes from the `sslinfo`
 * extension — so pgHero reports SSL only where somebody installed it, and
 * silently reports nothing where they did not. `pg_stat_ssl` is a core
 * catalog (PG 9.5+, well under this project's 14 floor) and needs no
 * install. It is also readable without `pg_read_all_stats`: the restriction
 * on that view hides OTHER backends' rows, and this query asks only for
 * `pg_backend_pid()`, which is always our own. Same capability, no extension,
 * one fewer thing to be denied.
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
 * `server_version_num` is major * 10000 + minor: 170002 is 17.2, 140012 is
 * 14.12. The pre-10 scheme (90600 for 9.6, where the major is two
 * components) is not handled because this project floors at 14.
 */
function formatVersion(num: string | undefined): string | null {
  if (num == null) return null;
  const n = Number(num);
  if (!Number.isFinite(n)) return null;
  return `${Math.floor(n / 10000)}.${n % 10000}`;
}

export const identity: Check<IdentityRow, IdentityData> = {
  id: 'identity',
  title: 'Connection identity',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    return {
      database: r?.database ?? null,
      user: r?.user ?? null,
      serverVersion: formatVersion(r?.server_version_num),
      // `??`, never `||`: `false` is a finding — this connection is not
      // encrypted — and `||` would launder it into `null`, "we could not
      // look", which is the quiet direction of the same mistake the missing
      // row above guards against. Same for `replica`.
      replica: r?.replica ?? null,
      ssl: r?.ssl ?? null,
    };
  },
};
