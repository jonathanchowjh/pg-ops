import type { SqlQuery, Tool } from '../types.js';
import { queryStats, type QueryStatRow, type QueryStatsOpts } from '../checks/query-stats.js';
import { MAX_STATEMENT_LENGTH, planStatements } from './explain.js';
import { adviseOn, byName, type IndexAdvice, type IndexSuggestion } from './advice.js';
import { ownSql } from '../run.js';

/**
 * pgHero's dashboard thresholds (mean of 20ms, 50 calls), and a cap on how
 * many shapes are read.
 */
const SUGGESTION_DEFAULTS = { minMeanMs: 20, minCalls: 50, limit: 100 } as const;

export interface SuggestedIndexOpts { minMeanMs?: number; minCalls?: number; limit?: number }

interface QueryAdvice {
  queryid: string | null;
  query: string;
  calls: number;
  meanMs: number;
  /** Why this shape could not be planned: a `SET`, a dropped table, a privilege. */
  error?: string;
  advice: IndexAdvice[];
}

interface SuggestedIndex extends IndexSuggestion {
  queries: { queryid: string | null; query: string }[];
}

export interface SuggestedIndexes {
  /** Distinct indexes, found and not already covered. */
  indexes: SuggestedIndex[];
  /** Every shape that cleared the thresholds, and what was concluded about it. */
  byQuery: QueryAdvice[];
  /** Shapes read, before the thresholds were applied. */
  examined: number;
  /** Every shape pg_stat_statements holds for this database. */
  totalShapes: number;
  statsResetAt: string | null;
}

/** Suggestions found and not covered, grouped by index, sorted by table then columns. */
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
  return [...groups.values()].sort((a, b) => byName(key(a), key(b)));
}

/**
 * Index suggestions per query shape, and grouped by index, in one pass.
 *
 * Uses the `queryStats` check's own sql and map, so its redaction and
 * per-database scoping apply here unchanged. Its errors propagate raw, so
 * `runTool` classifies a missing pg_stat_statements as the check does.
 *
 * Reads live statistics since the last reset, not captured history as
 * pgHero does: the store is optional, pg_stat_statements is not.
 */
export const suggestedIndexes: Tool<SuggestedIndexOpts, SuggestedIndexes> = {
  id: 'suggestedIndexes',
  requires: [{ kind: 'extension', name: 'pg_stat_statements' }],
  run: async (ctx, opts) => {
    const o = { ...SUGGESTION_DEFAULTS, ...opts };
    const sql = queryStats.sql as (x: QueryStatsOpts) => SqlQuery;
    const { text, values } = sql({ sort: 'total', limit: o.limit });
    // This runs outside runCheck, so the marker toQuery would add is added
    // here.
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
