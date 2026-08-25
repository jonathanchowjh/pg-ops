/**
 * Shared duration formatting (plan §A1/§A3). Originally lived in
 * `commands/locks/chain.ts`; moved here because `commands/sessions` needs the
 * same formatting and importing across command modules would create an
 * awkward cross-command dependency.
 */

import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
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
 * Truncate `text` to at most `width` *display columns*, measured with
 * `string-width`.
 *
 * `cli-truncate@4` does not honour its own width cap when the cut lands on a
 * wide or astral grapheme it does not classify as fullwidth. Measured
 * directly: `cliTruncate('🔥🔥🔥', 4)` returns `'🔥🔥🔥…'`, which is **7** display
 * columns — 3 over the requested cap of 4. (`cliTruncate('a🔥b', 3)`
 * similarly overshoots to 4.) A caller that pads a cell to
 * `width - stringWidth(truncated)` sees that deficit clamp to 0 via
 * `Math.max(0, …)` and skips padding, so the cell renders over-wide and
 * shoves every column to its right out of alignment — exactly the
 * misalignment this project measures in display columns, not UTF-16 code
 * units, to avoid. Do not "simplify" this back to a bare
 * `cliTruncate(text, width)` call.
 *
 * The fix steps the requested cap down and re-truncates until the *actual*
 * rendered width is within budget. Terminates for every input, including a
 * string whose very first grapheme is already wider than `width`
 * (`fitToWidth('🔥', 1)` returns `'…'`, itself exactly 1 column): `budget`
 * strictly decreases each iteration, and `cliTruncate(_, 1)` is always at
 * most one display column, so the loop exits by `budget === 1` at the
 * latest.
 */
export function fitToWidth(text: string, width: number): string {
  if (width <= 0) return '';
  let budget = width;
  let out = cliTruncate(text, budget);
  while (budget > 1 && stringWidth(out) > width) out = cliTruncate(text, --budget);
  return out;
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
 *
 * `max` is *display columns*, fit with `fitToWidth` — the same helper
 * `ui/table-layout.ts`'s `formatCell` uses, and for the same reason.
 * `.length`/`.slice` count UTF-16 code units: a CJK identifier or an emoji in
 * a string literal is one code unit but two display columns, so a cap of N
 * code units can render as 2N columns. Every caller renders to a terminal, and
 * `sessions`' detail panel now passes the terminal's own width — a line one
 * column too wide wraps and grows the panel under the table.
 */
export function truncateQuery(query: string | null, max = 80): string {
  if (!query) return '<no query>';
  const collapsed = redactSecrets(query.replace(/\s+/g, ' ').trim());
  return fitToWidth(collapsed, max);
}
