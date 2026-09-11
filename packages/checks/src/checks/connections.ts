import type { Check, Verdict } from '../types.js';

export interface ConnectionsRow {
  /**
   * All three columns are cast `::int` in the query below (OID 23, int4).
   * node-pg's default type parser hands int4 back as a JS `number`, not a
   * `string` — unlike int8/bigint columns (e.g. the pg_stat_statements
   * counters later checks read), which node-pg deliberately leaves as
   * strings to avoid silently losing precision above 2^53. Type each
   * column as what actually arrives; a check whose columns are genuinely
   * bigint should type those fields `string` and keep converting with
   * `Number(...)`, with a comment noting why.
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
 * Pre-port review A3: headroom was `max_connections - count(client backends)`,
 * which ignores superuser_reserved_connections (default 3) and, on PG16+,
 * reserved_connections. On a default max_connections=100 the alarm fired three
 * connections later than the pool an app role can actually draw from — on the
 * one check whose entire purpose is warning before "FATAL: too many
 * connections".
 *
 * `current_setting(_, true)` is missing_ok: reserved_connections does not exist
 * below PG16, and this check must run on PG14. `missing_ok = true` makes
 * `current_setting` return NULL for an unrecognized parameter instead of
 * raising `unrecognized configuration parameter` (an error, not a NULL, when
 * called without the second argument). The NULL is folded to `0` by
 * `NULLIF(..., '')::int` then `COALESCE(..., 0)` before it ever leaves SQL —
 * resolved server-side, so a NULL-to-NaN hazard never has the chance to reach
 * JavaScript. That makes this single SQL text run unchanged across the whole
 * 14/16/17/18 CI matrix; no `ctx.serverVersion` branch is needed.
 *
 * `backend_type = 'client backend'` matches `src/commands/home/query.ts`'s
 * CONNECTIONS_SQL: on PG16/17, pg_stat_activity also surfaces auxiliary
 * processes (checkpointer, background writer, walwriter, archiver, startup)
 * that do NOT draw from the max_connections pool. Counting them would
 * inflate `used` and under-report headroom on the one check whose job is to
 * warn before "too many connections" — scope to real client backends.
 */
const SQL = `
SELECT current_setting('max_connections')::int AS max_connections,
       current_setting('superuser_reserved_connections')::int
         + COALESCE(NULLIF(current_setting('reserved_connections', true), '')::int, 0) AS reserved,
       (SELECT count(*)::int FROM pg_stat_activity
         WHERE backend_type = 'client backend') AS used`;

export const connections: Check<ConnectionsRow, ConnectionsData> = {
  id: 'connections',
  gate: 'connect',
  title: 'Connection headroom',
  class: 'incident',
  sql: SQL,
  map: (rows) => {
    const r = rows[0];
    const max = r?.max_connections ?? 0;
    const used = r?.used ?? 0;
    const reserved = r?.reserved ?? 0;
    return { max, used, reserved, headroom: max - reserved - used };
  },
  thresholds: [
    { level: 'warn', value: 20, unit: 'percent',
      because: 'below a fifth of the pool free, a normal traffic spike can exhaust it '
             + 'before anyone reacts',
      remedy: 'Find what is holding connections open — Sessions groups them by state — '
            + 'and put a pooler in front before the next spike rather than during it.' },
    { level: 'critical', value: 10, unit: 'percent',
      because: 'below a tenth, connection refusals are minutes away and the fix '
             + '(pgbouncer, or killing idle-in-transaction) takes longer than that',
      remedy: 'Reclaim headroom now by terminating idle-in-transaction sessions; a pooler '
            + 'cannot be deployed in the time left. Set '
            + 'idle_in_transaction_session_timeout on the application role so it does '
            + 'not recur.' },
  ],
  /**
   * `t.find(...)` may come back `undefined` — this must stay safe for a
   * later check that copies this shape with a different (or incomplete)
   * threshold set, rather than throwing on a non-null assertion. Absence of
   * a level's threshold means that level simply never fires; it does not
   * fall back to a hard-coded number, since thresholds are configuration
   * data (the `t` parameter), not a module constant this function may close
   * over instead.
   */
  verdict: (d, t): Verdict => {
    const pct = d.max > 0 ? (d.headroom / d.max) * 100 : 100;
    const note = `${d.headroom} connections left`;
    const crit = t.find((x) => x.level === 'critical');
    if (crit && pct < crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && pct < warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};

export interface ConnectionDetailOpts { limit?: number }

export interface ConnectionDetailRow {
  pid: number;
  /** NULL for auxiliary backends, which have no database. */
  database: string | null;
  user: string | null;
  /** `application_name`; empty string when the client never set one. */
  source: string | null;
  /** NULL for unix-socket connections AND when unreadable — see `sslStatus`. */
  ip: string | null;
  state: string | null;
  /** NULL when pg_stat_ssl has no row for this backend: "we could not look". */
  ssl: boolean | null;
  /**
   * Pre-LIMIT count, carried on every row. `count(*)` is bigint, but the
   * query casts it `::int` and this is typed `number` to match sessions.ts
   * line 114 exactly — the same figure, computed the same way, in the sibling
   * check. A connection count cannot approach 2^31.
   */
  total_matching: number;
}

export type SslStatus = 'SSL' | 'No SSL' | 'Socket' | 'Internal Process' | 'Unknown';

export interface ConnectionSource {
  database: string | null;
  user: string | null;
  source: string | null;
  ip: string | null;
  connections: number;
  /**
   * The same grouping key `map` below computes, carried onto the row so a
   * React list key downstream doesn't have to re-derive a weaker one. Built
   * with `JSON.stringify` per field, not a plain template literal: a real
   * `application_name` of the text `"null"` would otherwise stringify
   * identically to a genuinely NULL field and collide two distinct groups
   * into one key. `JSON.stringify(null)` is the 4-character `null`;
   * `JSON.stringify('null')` is the 6-character `"null"` (quoted) — the two
   * cannot collide.
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
 * pgHero's classification (home_controller.rb#connections, params[:security]),
 * kept because each branch encodes a real distinction — extended with a fifth
 * value pgHero's own boolean-backed scheme has no room for:
 *
 *  - no database → an auxiliary process (checkpointer, walwriter, autovacuum
 *    launcher). Not an unencrypted client; counting it as one would put a
 *    permanent false finding on every server.
 *  - no ip, known state → a unix socket. Local, and not meaningfully insecure
 *    — a fact about TRANSPORT, decided before `ssl` is even consulted, so it
 *    takes priority over `'Unknown'` below: a socket is a socket whether or
 *    not `pg_stat_ssl` happened to have a row for it.
 *  - `ssl IS NULL` (and not a socket) → `pg_stat_ssl` had no row for this
 *    backend: we could not look, full stop. This must render as `'Unknown'`,
 *    not `'No SSL'` — the mirror of identity.ts's `ssl` rule (which
 *    identity.test.ts pins in both directions): NULL must never render as
 *    encrypted, but it must equally never render as a confirmed FINDING of
 *    "unencrypted." An earlier version of this function folded `ssl: null`
 *    into `'No SSL'`, turning "we could not look" into "measured, and
 *    definitely unencrypted" — a false security finding manufactured out of
 *    missing data, worse than reporting nothing.
 *  - `ssl = false` (measured, not a socket) → `'No SSL'` is a real finding:
 *    the backend was read and IS unencrypted. This is the case `'Unknown'`
 *    must not swallow the other way — `ssl: false` with a readable ip/state
 *    stays `'No SSL'` even though a NULL `ssl` next to it would be
 *    `'Unknown'`.
 *
 * `ssl === true` rather than truthiness: NULL means pg_stat_ssl had no row,
 * and must never render as encrypted.
 */
export function sslStatus(row: ConnectionDetailRow): SslStatus {
  if (row.ssl === true) return 'SSL';
  if (!row.database) return 'Internal Process';
  if (row.ip === null && row.state !== null) return 'Socket';
  if (row.ssl === null) return 'Unknown';
  return 'No SSL';
}

/**
 * ONE query backs #4 (the list), #7 (sources) and #65 (the security
 * breakdown), because pgHero's own controller derives all three from one
 * `@database.connections` call. Three queries would be three snapshots of a
 * table that changes between them, and the source counts would not sum to
 * the list. Same reasoning as identity.ts backing #1/#2/#3/#48.
 *
 * `count(*) OVER ()` carries the pre-LIMIT total on every row: Postgres
 * evaluates window functions before ORDER BY/LIMIT, so the figure survives
 * the clip. See sessions.ts, where this was established.
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
  gate: 'connect',
  title: 'Connections',
  class: 'incident',
  sql: (o) => ({ text: DETAIL_SQL, values: [o.limit ?? 500] }),
  map: (rows) => {
    const bySslStatus: Partial<Record<SslStatus, number>> = {};
    const sourceIndex = new Map<string, ConnectionSource>();
    for (const r of rows) {
      const status = sslStatus(r);
      bySslStatus[status] = (bySslStatus[status] ?? 0) + 1;
      // `\0`-joined, not `/`-joined: `application_name` commonly contains
      // `/`, and this key backs both the SSL-status grouping above and a
      // React list key downstream (sessions/page.tsx), where a `/`-joined
      // collision would merge two distinct source rows under one key on a
      // page that re-renders every five seconds. Each field is
      // JSON.stringify'd rather than interpolated directly — see the `key`
      // field's doc comment on ConnectionSource for why that, not the join
      // character, is what actually keeps a real `"null"` value from
      // colliding with a genuine NULL.
      const key = [r.database, r.user, r.source, r.ip].map((v) => JSON.stringify(v)).join('\0');
      const existing = sourceIndex.get(key);
      if (existing) existing.connections += 1;
      else sourceIndex.set(key, {
        database: r.database, user: r.user, source: r.source, ip: r.ip, connections: 1, key,
      });
    }
    // `?? 0` on an empty result, not `?? null`: zero connections is a fact we
    // measured, not a thing we failed to look at. An empty pg_stat_activity
    // cannot happen (we are in it), so this is the no-rows-at-all case. No
    // `Number(...)` — the column is cast `::int` in SQL and arrives a number,
    // per sessions.ts and this package's "type what actually arrives" rule.
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
