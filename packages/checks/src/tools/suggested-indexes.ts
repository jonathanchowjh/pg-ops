import type { SqlQuery, Tool } from '../types.js';
import { queryStats, type QueryStatRow, type QueryStatsOpts } from '../checks/query-stats.js';
import { MAX_STATEMENT_LENGTH, planStatements } from './explain.js';
import { adviseOn, type IndexAdvice, type IndexSuggestion } from './advice.js';
import { ownSql } from '../run.js';

/**
 * pgHero's dashboard thresholds (`home_controller.rb`, v4.0.1:
 * `set_suggested_indexes(params[:min_average_time] || 20, params[:min_calls] || 50)`),
 * and a cap on how many shapes get planned.
 */
export const SUGGESTION_DEFAULTS = { minMeanMs: 20, minCalls: 50, limit: 100 } as const;

export interface SuggestedIndexOpts { minMeanMs?: number; minCalls?: number; limit?: number }

export interface QueryAdvice {
  queryid: string | null;
  query: string;
  calls: number;
  meanMs: number;
  /** Why this shape could not be planned — a `SET`, a dropped table, a privilege. */
  error?: string;
  advice: IndexAdvice[];
}

export interface SuggestedIndex extends IndexSuggestion {
  queries: { queryid: string | null; query: string }[];
}

export interface SuggestedIndexes {
  /** #58 — distinct indexes, found and not already covered. */
  indexes: SuggestedIndex[];
  /** #63 — every shape that cleared the thresholds, and what was concluded about it. */
  byQuery: QueryAdvice[];
  /** Shapes read, before the thresholds were applied. */
  examined: number;
  /** Every shape pg_stat_statements holds for this database — what `limit` left unread. */
  totalShapes: number;
  statsResetAt: string | null;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** pgHero's `suggested_indexes`: found, not covered, grouped by index, sorted by table then columns. */
export function groupSuggestions(byQuery: readonly QueryAdvice[]): SuggestedIndex[] {
  const groups = new Map<string, SuggestedIndex>();
  for (const q of byQuery) {
    for (const a of q.advice) {
      if (!a.found || a.coveredBy !== undefined || a.suggestion === undefined) continue;
      const g = groups.get(a.suggestion.statement) ?? { ...a.suggestion, queries: [] };
      if (!g.queries.some((x) => x.query === q.query)) g.queries.push({ queryid: q.queryid, query: q.query });
      groups.set(a.suggestion.statement, g);
    }
  }
  const key = (g: SuggestedIndex) => JSON.stringify([g.schema, g.table, ...g.columns]);
  return [...groups.values()].sort((a, b) => byKey(key(a), key(b)));
}

/**
 * #58 `suggested_indexes` and #63 `suggested_indexes_by_query`, in one pass —
 * pgHero computes the first FROM the second too
 * (`suggested_indexes(suggested_indexes_by_query: …)`).
 *
 * Reads the `queryStats` check's OWN sql and map rather than restating them,
 * so the redaction and per-database scoping that check documents at length
 * apply here unchanged. Its errors propagate raw, so `runTool` classifies a
 * missing pg_stat_statements exactly as the check does, remedy included.
 *
 * Divergence D3: live statistics since the last reset, not pgHero's three
 * captured hours. History is optional in pgops; pg_stat_statements is not.
 */
export const suggestedIndexes: Tool<SuggestedIndexOpts, SuggestedIndexes> = {
  id: 'suggestedIndexes',
  title: 'Suggested indexes',
  requires: [{ kind: 'extension', name: 'pg_stat_statements' }],
  run: async (ctx, opts) => {
    const o = { ...SUGGESTION_DEFAULTS, ...opts };
    const sql = queryStats.sql as (x: QueryStatsOpts) => SqlQuery;
    const { text, values } = sql({ sort: 'total', limit: o.limit });
    // Reusing `queryStats`'s own sql() runs it OUTSIDE runCheck, so it never
    // passes through toQuery — the one place that calls `ownSql`. Without
    // this, this recurring pg_stat_statements read would rank on the Queries
    // page as if it were an operator's own query.
    const { rows } = await ctx.target.query(ownSql(text), values);
    const stats = queryStats.map(rows as QueryStatRow[]);

    const shapes = stats.rows.filter((r) => !r.redacted && r.query !== null
      && r.meanMs >= o.minMeanMs && r.calls >= o.minCalls);
    const plannable = shapes.filter((r) => r.query!.length <= MAX_STATEMENT_LENGTH);
    const planned = await planStatements(ctx, plannable.map((r) => r.query!));
    const advised = await adviseOn(ctx, planned.flatMap((p) => (p.ok ? [p.plan] : [])));

    // `planned` is parallel to `plannable`; `advised` to the plans that
    // succeeded. Two cursors keep each shape paired with its own answer.
    let p = 0;
    let a = 0;
    const byQuery = shapes.map((r): QueryAdvice => {
      const base = { queryid: r.queryid, query: r.query!, calls: r.calls, meanMs: r.meanMs };
      if (r.query!.length > MAX_STATEMENT_LENGTH) {
        return { ...base, error: `Longer than ${MAX_STATEMENT_LENGTH} characters; not planned.`, advice: [] };
      }
      const plan = planned[p++]!;
      return plan.ok ? { ...base, advice: advised[a++]! } : { ...base, error: plan.message, advice: [] };
    });

    return {
      indexes: groupSuggestions(byQuery),
      byQuery,
      examined: stats.rows.length,
      totalShapes: stats.totalShapes,
      statsResetAt: stats.statsResetAt,
    };
  },
};
