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

/** Collapse whitespace, escape table-breaking pipes, and shorten for one cell. */
export function cellQuery(query: string | null, max = 60): string {
  if (!query) return '<no query>';
  const collapsed = query.replace(/\s+/g, ' ').trim();
  const clipped = collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
  // A literal `|` (e.g. the `||` concat operator) would split the markdown cell.
  return clipped.replace(/\|/g, '\\|');
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
