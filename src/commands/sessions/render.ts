import { formatDuration, truncateQuery } from '../../core/format.js';
import type { SessionRow } from './query.js';

/**
 * Escape a value for use inside a markdown table cell. Postgres text fields
 * (queries, application_name, etc.) can legitimately contain a literal `|`
 * (e.g. the `||` string-concatenation operator) which would otherwise be
 * misread as a column delimiter and shatter the table.
 */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function sessionsToMarkdown(rows: SessionRow[]): string {
  if (rows.length === 0) return 'No client sessions.\n';
  const lines = [
    '| pid | state | in state | user@app | client | query |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.pid} | ${cell(r.state ?? '?')} | ${formatDuration(r.inStateSecs)} | ${cell(r.user ?? '?')}@${cell(r.app || '?')} | ${cell(r.clientAddr ?? '')} | ${cell(truncateQuery(r.query))} |`,
    ),
  ];
  return lines.join('\n') + '\n';
}
