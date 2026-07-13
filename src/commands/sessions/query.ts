import { query } from '../../core/connection.js';

/**
 * Live client-backend list from pg_stat_activity (plan §A3).
 *
 * Excludes background workers and pgops's own backend so the operator only
 * sees sessions they might actually need to triage or kill. Read-only: no
 * write actions live in this module.
 */
const SESSIONS_SQL = `
SELECT
  pid,
  state,
  usename                                            AS user,
  application_name                                   AS app,
  client_addr::text                                  AS client_addr,
  backend_start::text                                AS backend_start,
  EXTRACT(EPOCH FROM (now() - state_change))         AS in_state_secs,
  EXTRACT(EPOCH FROM (now() - query_start))          AS running_secs,
  query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
  AND pid <> pg_backend_pid()
ORDER BY pid
`;

/** One row of `pg_stat_activity`, coerced to JS-friendly types. */
export interface SessionRow {
  pid: number;
  state: string | null; // 'active' | 'idle' | 'idle in transaction' | …
  user: string | null;
  app: string | null;
  clientAddr: string | null;
  backendStart: string | null; // session identity for the kill guard
  inStateSecs: number | null;
  runningSecs: number | null;
  query: string | null;
}

export async function fetchSessions(): Promise<SessionRow[]> {
  // pg returns EXTRACT(EPOCH ...) as a numeric string; coerce to number here.
  const rows = await query<Record<string, unknown>>(SESSIONS_SQL);
  return rows.map((r) => ({
    pid: Number(r.pid),
    state: (r.state as string) ?? null,
    user: (r.user as string) ?? null,
    app: (r.app as string) ?? null,
    clientAddr: (r.client_addr as string) ?? null,
    backendStart: (r.backend_start as string) ?? null,
    inStateSecs: r.in_state_secs == null ? null : Number(r.in_state_secs),
    runningSecs: r.running_secs == null ? null : Number(r.running_secs),
    query: (r.query as string) ?? null,
  }));
}
