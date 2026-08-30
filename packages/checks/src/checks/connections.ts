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
             + 'before anyone reacts' },
    { level: 'critical', value: 10, unit: 'percent',
      because: 'below a tenth, connection refusals are minutes away and the fix '
             + '(pgbouncer, or killing idle-in-transaction) takes longer than that' },
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
