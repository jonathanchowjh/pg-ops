/**
 * Shared duration formatting (plan §A1/§A3). Originally lived in
 * `commands/locks/chain.ts`; moved here because `commands/sessions` needs the
 * same formatting and importing across command modules would create an
 * awkward cross-command dependency.
 */

import { redactSecrets } from './snapshot.js';

/** Human-friendly duration, e.g. 863 -> "14m 23s". */
export function formatDuration(secs: number | null): string {
  // null = unknown; negative = clock skew (xact_start in the future) — both meaningless.
  if (secs == null || secs < 0) return '—';
  const s = Math.floor(secs % 60);
  const m = Math.floor((secs / 60) % 60);
  const h = Math.floor(secs / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Shorten a query for inline display — and REDACT it (deep-review I3).
 *
 * `redactSecrets` used to guard only the two file sinks (`buildSnapshot`,
 * `writeAudit`), so snapshot files and the audit log were clean while every TUI
 * rendered `pg_stat_activity.query` verbatim: a caught-in-flight
 * `ALTER USER app PASSWORD 'hunter2'` appeared in plaintext on the cockpit's
 * LONG-RUNNING panel and in the sessions table. That terminal gets screenshotted
 * into Slack and screen-shared far more often than `s` gets pressed.
 *
 * This is the chokepoint every view already routed query text through for
 * whitespace collapsing, so redaction here covers all of them at once. Redact
 * BEFORE truncating: truncating first could clip a secret's tail and leave the
 * head of it on screen, unmatched by any pattern.
 */
export function truncateQuery(query: string | null, max = 80): string {
  if (!query) return '<no query>';
  const collapsed = redactSecrets(query.replace(/\s+/g, ' ').trim());
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
