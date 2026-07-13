import { truncateQuery } from '../../core/format.js';
import type { SortMode } from './stats.js';
import type { QueryRow } from './stats.js';

/**
 * Markdown table for the snapshot exporter (plan §A2). Mirrors locks/render.ts:
 * the view owns this body, core/snapshot.ts wraps it with the header + redaction.
 * Pasteable straight into a Slack incident channel or a postmortem.
 */

const TITLES: Record<SortMode, string> = {
  total: 'Top queries by total time',
  mean: 'Top queries by mean time',
  calls: 'Top queries by calls',
  cache: 'Top queries by cache hit (coldest first)',
};

/**
 * Collapse whitespace, redact, shorten for one cell, and escape table-breaking
 * pipes. Delegates to core/format.ts's `truncateQuery` so the TUI table (Top.tsx
 * renders through this too) inherits the same redaction as every other view
 * (deep-review I3) — the only thing top adds is the pipe escaping.
 */
export function cellQuery(query: string | null, max = 60): string {
  // A literal `|` (e.g. the `||` concat operator) would split the markdown cell.
  return truncateQuery(query, max).replace(/\|/g, '\\|');
}

function cachePct(pct: number | null): string {
  return pct === null ? '—' : `${Math.round(pct)}%`;
}

export function queryStatsToMarkdown(rows: QueryRow[], sort: SortMode): string {
  if (rows.length === 0) {
    return '_No query statistics. Is pg_stat_statements populated yet?_';
  }

  const lines = [
    `## ${TITLES[sort]}`,
    '',
    '| total ms | mean ms | calls | cache | query |',
    '| ---: | ---: | ---: | ---: | --- |',
  ];
  for (const r of rows) {
    lines.push(
      `| ${Math.round(r.totalMs)} | ${r.meanMs.toFixed(2)} | ${r.calls} | ${cachePct(r.cacheHitPct)} | ${cellQuery(r.query)} |`,
    );
  }
  return lines.join('\n');
}
