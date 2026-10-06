import type { Check, Verdict } from '../types.js';

export interface HorizonRow {
  kind: 'backend' | 'slot' | 'prepared';
  who: string;
  xmin_age: number;
  age_secs: string | null;
  detail: string;
  /** Holders that existed BEFORE the limit. Same pattern as long-running.ts. */
  total: number;
}
export interface HorizonHolder { kind: 'backend' | 'slot' | 'prepared'; who: string; xminAge: number; ageSecs: number | null; detail: string }
export interface HorizonData { holders: HorizonHolder[]; truncated: boolean }

/**
 * Vacuum cannot remove any row version that some snapshot might still need. The
 * oldest such snapshot — the xmin horizon — is held by exactly three kinds of
 * thing: a backend with an open transaction, a replication slot, or a prepared
 * transaction. When bloat grows while autovacuum runs on schedule, one of these
 * is why, and this lists them furthest-back first.
 *
 * JUDGED ON TRANSACTIONS, NOT SECONDS, and the distinction is the whole point.
 * `age(xid)` is how far back the horizon sits in xid space, which is what decides
 * how much garbage cannot be reclaimed. Wall-clock age does not: eleven minutes
 * on a quiet database pins a couple of dozen transactions, and eleven minutes on
 * a busy primary pins millions. Seconds are reported for the two kinds that have
 * them because "open for 11m" is how an operator spots the culprit, but they are
 * information, not the basis of the verdict.
 *
 * The first draft judged on seconds and therefore could not judge a slot at all,
 * which made the single most common cause of unreclaimable bloat render green.
 * `slots.ts` does not cover it either — it judges retained WAL bytes, and a
 * logical slot with a stuck `catalog_xmin` can retain almost none. If you are
 * tempted to move the verdict back onto seconds, that is the hole you are
 * reopening.
 */
const SQL = `
SELECT kind, who, xmin_age, age_secs, detail, count(*) OVER ()::int AS total
FROM (
  SELECT 'backend'::text AS kind, pid::text AS who, age(backend_xmin)::int AS xmin_age,
         EXTRACT(EPOCH FROM (now() - xact_start))::text AS age_secs,
         coalesce(nullif(application_name, ''), '—') || ' · ' || coalesce(state, 'unknown') AS detail
  FROM pg_stat_activity
  WHERE backend_xmin IS NOT NULL AND pid <> pg_backend_pid()
    -- Task 8, step 3b — same clause and same reasoning as activity.ts's own
    -- act CTE (see its comment for the full explanation): one page render
    -- fires about six checks in parallel on separate pool connections, and
    -- without this, pgops names one of its own backends as pinning the xmin
    -- horizon. Filtered on application_name rather than the OWN_SQL_MARKER
    -- this task adds, because a role without pg_read_all_stats can see a
    -- foreign backend's application_name but not its query (measured on live
    -- PG17). The empty-string guard stops an unnamed connection turning the
    -- pattern into '%', which would exclude every backend and leave this
    -- check permanently blind; pid <> pg_backend_pid() above still excludes
    -- the checking backend itself in exactly that case.
    AND (current_setting('application_name') = ''
         OR application_name NOT LIKE current_setting('application_name') || '%')
  UNION ALL
  SELECT 'slot', slot_name::text, greatest(age(xmin), age(catalog_xmin))::int, NULL,
         CASE WHEN active THEN 'active' ELSE 'inactive' END
  FROM pg_replication_slots
  WHERE xmin IS NOT NULL OR catalog_xmin IS NOT NULL
  UNION ALL
  SELECT 'prepared', gid, age(transaction)::int,
         EXTRACT(EPOCH FROM (now() - prepared))::text, owner::text
  FROM pg_prepared_xacts
) h
ORDER BY xmin_age DESC NULLS LAST
LIMIT 10`;

export const horizon: Check<HorizonRow, HorizonData> = {
  id: 'horizon',
  gate: 'keep-up',
  title: 'Oldest snapshot',
  class: 'incident',
  sql: SQL,
  map: (rows) => ({
    holders: rows.map((r) => ({
      kind: r.kind, who: r.who, xminAge: r.xmin_age,
      ageSecs: r.age_secs == null ? null : Number(r.age_secs), detail: r.detail,
    })),
    truncated: (rows[0]?.total ?? 0) > rows.length,
  }),
  thresholds: [
    { level: 'warn', value: 50_000_000, unit: 'transactions',
      because: 'fifty million transactions of pinned history is already tens of gigabytes of dead '
             + 'rows on a write-heavy database, and vacuum cannot reclaim any of it while the '
             + 'holder lives, however often it runs',
      remedy: 'End whatever holds it. A backend can be terminated from Sessions; a prepared '
            + 'transaction needs COMMIT PREPARED or ROLLBACK PREPARED by its owner; a slot that '
            + 'no longer has a consumer should be dropped with pg_drop_replication_slot.' },
    { level: 'critical', value: 200_000_000, unit: 'transactions',
      because: "200 million is autovacuum_freeze_max_age's default, the point at which Postgres "
             + 'starts forcing anti-wraparound vacuums that this holder will block, so the '
             + 'database is now accumulating a problem it cannot resolve on its own',
      remedy: 'Terminate the holder now — a slot with no consumer should be dropped — then check '
            + 'the Maintenance page for the tables carrying the most dead rows.' },
  ],
  /**
   * The worst holder by xid distance, whatever kind it is.
   *
   * Every kind is judged on the same axis, so there is no holder this function
   * has to stay silent about. The note names the kind because the remedy differs
   * completely between them, and reports seconds only for a holder that has them
   * — a slot has no start time, and inventing one would be the same over-claim as
   * calling it fine.
   */
  verdict: (d, t): Verdict => {
    const worst = d.holders.reduce<HorizonHolder | null>(
      (o, h) => (o === null || h.xminAge > o.xminAge ? h : o), null);
    if (worst === null) return { level: 'ok' };
    const when = worst.ageSecs === null ? '' : `, open ${Math.round(worst.ageSecs / 60)}m`;
    const note = `${worst.kind} ${worst.who} pins the horizon ${worst.xminAge} transactions back${when}`;
    const crit = t.find((x) => x.level === 'critical');
    if (crit && worst.xminAge >= crit.value) return { level: 'critical', note };
    const warn = t.find((x) => x.level === 'warn');
    if (warn && worst.xminAge >= warn.value) return { level: 'warn', note };
    return { level: 'ok' };
  },
};
