import { query } from '../../core/connection.js';

/**
 * Triage cockpit data layer (plan §M2 / dba-playbook/00-first-five-minutes.sql).
 *
 * Six independent, read-only queries that answer the "first five minutes"
 * questions a DBA runs from memory: who's connected and how, is anything
 * blocked, what's running long, are we near the connection cap, plus two
 * one-line health checks (wraparound horizon, replication slot bloat).
 *
 * Per-panel isolation (spec §5): a restricted managed Postgres (RDS, Cloud
 * SQL) may deny privileges for pg_replication_slots or the wraparound query.
 * Each query is wrapped in `panel()` so a single failure resolves to
 * `{ ok: false, error }` instead of throwing — the other panels still render.
 */

/** Per-panel result: either the data, or the error that kept it from loading. */
export type PanelResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface SessionsPanel {
  byState: { state: string; sessions: number; longestInStateSecs: number }[];
  oldestIdleInTxnSecs: number | null;
}

export interface BlockedPanel {
  blockedCount: number;
  longestWaitSecs: number | null;
  suspectPid: number | null;
}

export interface LongRunningRow {
  pid: number;
  runningSecs: number;
  query: string;
}

export interface ConnectionsPanel {
  used: number;
  max: number;
  headroom: number;
}

export interface WraparoundCard {
  pctOfHorizon: number;
}

export interface SlotsCard {
  inactiveCount: number;
  retainedBytes: number;
  worstSlot: string | null;
}

export interface TriageData {
  sessions: PanelResult<SessionsPanel>;
  blocked: PanelResult<BlockedPanel>;
  longRunning: PanelResult<LongRunningRow[]>;
  connections: PanelResult<ConnectionsPanel>;
  wraparound: PanelResult<WraparoundCard>;
  slots: PanelResult<SlotsCard>;
}

// 1. WHO IS CONNECTED, AND WHAT ARE THEY DOING? (playbook 00 §1)
// 'idle in transaction' older than a few minutes is the #1 preventable cause
// of lock pile-ups and bloat — the model layer flags it via oldestIdleInTxnSecs.
const SESSIONS_SQL = `
SELECT state,
       count(*)::int                                          AS sessions,
       max(EXTRACT(EPOCH FROM (now() - state_change)))        AS longest_secs
FROM pg_stat_activity
WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
GROUP BY state ORDER BY sessions DESC`;

// 2. IS ANYTHING BLOCKED RIGHT NOW? (playbook 00 §2)
// pg_blocking_pids() is the fast yes/no for lock contention; aggregated to a
// single summary row here (the full wait graph is `pgops locks`).
const BLOCKED_SQL = `
SELECT count(*)::int                                                        AS blocked,
       max(EXTRACT(EPOCH FROM (now() - query_start)))                       AS longest_wait_secs,
       (array_agg((pg_blocking_pids(pid))[1]
          ORDER BY now() - query_start DESC))[1]                            AS suspect_pid
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0`;

// 3. THE LONGEST-RUNNING QUERIES RIGHT NOW (playbook 00 §3)
const LONG_RUNNING_SQL = `
SELECT pid, EXTRACT(EPOCH FROM (now() - query_start)) AS running_secs, query
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend'
  AND pid <> pg_backend_pid() AND now() - query_start > interval '5 seconds'
ORDER BY running_secs DESC LIMIT 3`;

// 4. CONNECTION HEADROOM (playbook 00 §4)
// Deliberate deviation from the playbook's raw count(*): on PG16/17,
// pg_stat_activity also surfaces auxiliary processes (checkpointer,
// background writer, walwriter, archiver, startup) that do NOT draw from
// the max_connections pool. Counting them inflates `used` and under-reports
// headroom on the one panel whose job is to warn before "too many
// connections" — scope to real client backends, matching SESSIONS_SQL and
// LONG_RUNNING_SQL above.
const CONNECTIONS_SQL = `
SELECT count(*)::int                                       AS used,
       current_setting('max_connections')::int             AS max
FROM pg_stat_activity
WHERE backend_type = 'client backend'`;

// 5. WRAPAROUND HORIZON (playbook 03 §2, database-wide via pg_database.datfrozenxid)
// Global percentage toward the anti-wraparound forced vacuum, for a one-line verdict.
const WRAPAROUND_SQL = `
SELECT round(100.0 * max(age(datfrozenxid))
       / current_setting('autovacuum_freeze_max_age')::float)::int AS pct
FROM pg_database`;

// 6. REPLICATION SLOT HEALTH (playbook 04 §1)
// The danger case: an inactive slot retaining a large amount of WAL — the
// orphan slot that can fill the primary's disk.
const SLOTS_SQL = `
SELECT count(*) FILTER (WHERE NOT active)::int AS inactive,
       coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
                FILTER (WHERE NOT active), 0)::bigint AS retained_bytes,
       (array_agg(slot_name ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) DESC NULLS LAST)
                FILTER (WHERE NOT active))[1] AS worst_slot
FROM pg_replication_slots`;

/**
 * The message to show for a failed panel.
 *
 * Node raises an `AggregateError` when a host resolves to several addresses and
 * every connect attempt fails (the ordinary "database is down" case: ::1 and
 * 127.0.0.1 both refused). Its `.message` is empty, so the naive
 * `(err as Error).message` renders the panel as `n/a ()` — an unexplained
 * failure at exactly the moment the operator needs the reason. Unwrap it.
 */
export function panelErrorMessage(err: unknown): string {
  const e = err as { message?: string; errors?: unknown[] };
  if (e?.message) return e.message;
  if (Array.isArray(e?.errors)) {
    const parts = e.errors.map((x) => (x as Error | undefined)?.message).filter(Boolean);
    if (parts.length > 0) return parts.join('; ');
  }
  return String(err);
}

/** Runs one panel's query, converting any failure into a `PanelResult` instead of throwing. */
async function panel<T>(run: () => Promise<T>): Promise<PanelResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (err) {
    return { ok: false, error: panelErrorMessage(err) };
  }
}

/**
 * Pure: derive the sessions panel from already-mapped `byState` rows.
 *
 * Postgres has TWO idle-in-transaction states — 'idle in transaction' and
 * 'idle in transaction (aborted)' — which SESSIONS_SQL's `GROUP BY state`
 * puts in separate rows. `oldestIdleInTxnSecs` must be the longest duration
 * across BOTH variants, not just whichever variant has more sessions.
 * Exported for unit testing (query.test.ts).
 */
export function mapSessionsPanel(byState: SessionsPanel['byState']): SessionsPanel {
  const oldestIdleInTxnSecs = byState.reduce<number | null>((longest, s) => {
    if (!s.state.startsWith('idle in transaction')) return longest;
    return longest == null || s.longestInStateSecs > longest ? s.longestInStateSecs : longest;
  }, null);
  return { byState, oldestIdleInTxnSecs };
}

/**
 * Pure: derive the slots panel from the single SLOTS_SQL result row.
 *
 * `worstSlot` and `retainedBytes` are computed together in SQL (see
 * SLOTS_SQL's `NULLS LAST` fix) so they always name the same slot; this
 * mapper just coerces the row's numeric-string fields. Exported for
 * unit testing (query.test.ts).
 */
export function mapSlotsPanel(row: Record<string, unknown> | undefined): SlotsCard {
  return {
    inactiveCount: Number(row?.inactive ?? 0),
    retainedBytes: Number(row?.retained_bytes ?? 0),
    worstSlot: (row?.worst_slot as string) ?? null,
  };
}

export async function fetchTriage(): Promise<TriageData> {
  const [sessions, blocked, longRunning, connections, wraparound, slots] = await Promise.all([
    panel(async () => {
      // pg returns EXTRACT(EPOCH ...) and count(*)::int as numeric strings; coerce here.
      const rows = await query<Record<string, unknown>>(SESSIONS_SQL);
      const byState = rows.map((r) => ({
        state: (r.state as string) ?? 'unknown',
        sessions: Number(r.sessions),
        longestInStateSecs: Number(r.longest_secs ?? 0),
      }));
      return mapSessionsPanel(byState);
    }),
    panel(async () => {
      const [r] = await query<Record<string, unknown>>(BLOCKED_SQL);
      return {
        blockedCount: Number(r?.blocked ?? 0),
        longestWaitSecs: r?.longest_wait_secs == null ? null : Number(r.longest_wait_secs),
        suspectPid: r?.suspect_pid == null ? null : Number(r.suspect_pid),
      };
    }),
    panel(async () => {
      const rows = await query<Record<string, unknown>>(LONG_RUNNING_SQL);
      return rows.map((r) => ({
        pid: Number(r.pid),
        runningSecs: Number(r.running_secs),
        query: (r.query as string) ?? '',
      }));
    }),
    panel(async () => {
      const [r] = await query<Record<string, unknown>>(CONNECTIONS_SQL);
      const used = Number(r?.used ?? 0);
      const max = Number(r?.max ?? 0);
      return { used, max, headroom: max - used };
    }),
    panel(async () => {
      const [r] = await query<Record<string, unknown>>(WRAPAROUND_SQL);
      return { pctOfHorizon: Number(r?.pct ?? 0) };
    }),
    panel(async () => {
      const [r] = await query<Record<string, unknown>>(SLOTS_SQL);
      return mapSlotsPanel(r);
    }),
  ]);
  return { sessions, blocked, longRunning, connections, wraparound, slots };
}
