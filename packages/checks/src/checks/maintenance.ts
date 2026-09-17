import type { Check } from '../types.js';
import { DEFAULT_LIMIT, visibleSchemas, type ListOpts } from './indexes.js';
import { HARD_LIMIT } from './wraparound.js';

/**
 * #43 `maintenance_info` is NOT here, and that is deliberate.
 *
 * pgHero's `maintenance_info` reads `pg_stat_user_tables` and returns
 * `(schema, table, last_vacuum, last_autovacuum, last_analyze,
 * last_autoanalyze, dead_rows, live_rows)`. `tables.ts`'s `tableStats` — #36,
 * already shipped — reads the same view and returns the same eight fields;
 * its docblock records that it diverged from pgHero's `table_stats` precisely
 * by adopting this shape. A second check would differ from it only in its
 * `ORDER BY`, and the maintenance page would then have two answers to one
 * question. `registry.ts` maps #43 onto `tableStats` instead, the way #49 and
 * #51 both map onto `replicationLag`.
 */

export interface AutovacuumDangerRow {
  relation: string;
  /**
   * `age(xid)` returns int4 and node-pg hands that back as a JS number
   * already — the same convention `wraparound.ts` documents at length.
   */
  xact_age: number;
  total: number;
}

export interface RelationXidAge {
  relation: string;
  xactAge: number;
  /** Transactions left before the server refuses writes. Counts DOWN. */
  txnsRemaining: number;
}

export interface AutovacuumDangerData {
  relations: RelationXidAge[];
  total: number;
  truncated: boolean;
}

/**
 * #45, the per-relation detail behind the shipped `wraparound` alarm (#44).
 *
 * Four decisions, each of which a plausible transcription gets wrong:
 *
 * **The TOAST relation counts.** pgHero reads
 * `GREATEST(AGE(c.relfrozenxid), AGE(t.relfrozenxid))`, and the reason is that
 * a table's TOAST relation freezes independently of its heap. Read the heap
 * alone and a table whose TOAST holds the oldest xid in the database reports
 * an age of zero. `GREATEST` ignores NULLs in Postgres, so the `LEFT JOIN`
 * missing (`reltoastrelid = 0`) yields the heap age rather than NULL.
 *
 * **Relations with no storage must be excluded.** A partitioned parent has
 * `relfrozenxid = 0` and `age(0)` is 2147483647, so it reports zero
 * transactions remaining — permanently, at the top of the list, on every
 * database that uses partitioning. `relkind IN ('r', 'm')` excludes it. We
 * include matviews where pgHero's `relkind = 'r'` does not: a matview has
 * storage and holds an xid back exactly as a table does.
 *
 * **Catalog schemas are excluded**, unlike pgHero — which gets away with it
 * because `transaction_id_danger` filters by a threshold and catalogs almost
 * never cross it. This is an unfiltered listing, so 100+ catalog rows would
 * fill the cap and hide every user table. A catalog genuinely holding xids
 * back still shows up: `wraparound` reads `pg_database.datfrozenxid`, which
 * covers every relation in the database.
 *
 * **`txnsRemaining` is derived in `map`, not in SQL.** `2147483647 - age(...)`
 * is int4 arithmetic and overflows if `age()` is negative — reachable on a
 * standby or after `pg_resetwal`, and verified on 17.11: `SELECT 2147483647 -
 * (-1)::int` is `ERROR: integer out of range`. Computing it in JS removes the
 * overflow and, more usefully, removes the possibility that the age this
 * check reports and the age it subtracts from drift apart.
 */
const AUTOVACUUM_DANGER_SQL = `
SELECT n.nspname || '.' || c.relname AS relation,
       a.xact_age,
       count(*) OVER ()::int AS total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
CROSS JOIN LATERAL (
  SELECT greatest(age(c.relfrozenxid), age(t.relfrozenxid)) AS xact_age
) a
WHERE c.relkind IN ('r', 'm')
  AND ${visibleSchemas('n.nspname')}
ORDER BY a.xact_age DESC, relation
LIMIT $1`;

export function toAutovacuumDanger(rows: AutovacuumDangerRow[]): AutovacuumDangerData {
  const total = rows[0]?.total ?? 0;
  return {
    relations: rows.map((r) => ({
      relation: r.relation,
      xactAge: r.xact_age,
      txnsRemaining: HARD_LIMIT - r.xact_age,
    })),
    total,
    truncated: total > rows.length,
  };
}

export const autovacuumDanger: Check<AutovacuumDangerRow, AutovacuumDangerData, ListOpts> = {
  id: 'autovacuumDanger',
  title: 'Transaction ID age by relation',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: (o) => ({ text: AUTOVACUUM_DANGER_SQL, values: [o.limit ?? DEFAULT_LIMIT] }),
  map: toAutovacuumDanger,
  /**
   * No verdict, and this one is a ruling rather than §2.2's default.
   *
   * `wraparound` (#44) owns the wraparound alarm and reads the database-wide
   * `datfrozenxid`, which is the minimum over every relation — so it cannot
   * miss what this check would find. Giving this list its own thresholds
   * would put two badges on one fact, and they would disagree the moment
   * either set of numbers was tuned. This is the detail an operator opens
   * after that alarm fires, to find out which relation to vacuum first.
   */
};

export interface VacuumProgressRow {
  pid: number;
  phase: string;
  /** NULL if the relation was dropped between the view read and the join. */
  relation: string | null;
  blks_total: string;
  blks_scanned: string;
}

export interface RunningVacuum {
  pid: number;
  phase: string;
  relation: string | null;
  blksTotal: number;
  blksScanned: number;
  /**
   * `null` means "not yet known", never "no progress".
   *
   * The `initializing` phase reports `heap_blks_total = 0`, and a vacuum that
   * has just started is the single most likely one for an operator to be
   * looking at. Rendering `0%` there would say the vacuum is stuck.
   */
  pctScanned: number | null;
}

export interface VacuumProgressData { vacuums: RunningVacuum[] }

/**
 * #46. No `ListOpts`: `pg_stat_progress_vacuum` holds one row per running
 * worker, bounded by `autovacuum_max_workers` plus whatever manual sessions
 * are vacuuming. There is nothing to cap and so nothing to truncate.
 *
 * `datname = current_database()` is pgHero's filter and is load-bearing — the
 * view is cluster-wide, and a vacuum running in a neighbouring database would
 * otherwise appear on this database's page.
 *
 * pgHero returns `pid` and `phase` only. The block counts are what turn "a
 * vacuum is running" into "it is 40% through and moving", which is the
 * question an operator has while waiting. `heap_blks_total` and
 * `heap_blks_scanned` exist from PG 13; the columns added in 17
 * (`indexes_total`, `indexes_processed`) are deliberately not read, because
 * the CI matrix floor is 14.
 */
const VACUUM_PROGRESS_SQL = `
SELECT v.pid,
       v.phase,
       n.nspname || '.' || c.relname AS relation,
       v.heap_blks_total::text AS blks_total,
       v.heap_blks_scanned::text AS blks_scanned
FROM pg_stat_progress_vacuum v
LEFT JOIN pg_class c ON c.oid = v.relid
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE v.datname = current_database()
ORDER BY v.pid`;

export function toVacuumProgress(rows: VacuumProgressRow[]): VacuumProgressData {
  return {
    vacuums: rows.map((r) => {
      const blksTotal = Number(r.blks_total);
      const blksScanned = Number(r.blks_scanned);
      return {
        pid: r.pid,
        phase: r.phase,
        relation: r.relation,
        blksTotal,
        blksScanned,
        pctScanned: blksTotal > 0 ? Math.round((100 * blksScanned) / blksTotal) : null,
      };
    }),
  };
}

export const vacuumProgress: Check<VacuumProgressRow, VacuumProgressData> = {
  id: 'vacuumProgress',
  title: 'Running vacuums',
  gate: 'keep-up',
  class: 'hygiene',
  timeoutMs: 10_000,
  sql: VACUUM_PROGRESS_SQL,
  map: toVacuumProgress,
  // No verdict: §2.2. An empty list is the normal state of a healthy
  // database, and a running vacuum is Postgres working, not a problem.
};
