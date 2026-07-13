import { formatDuration, truncateQuery } from '../../core/format.js';
import {
  verdictBlocked,
  verdictConnections,
  verdictLongRunning,
  verdictSessions,
  verdictSlots,
  verdictWraparound,
  type Verdict,
} from './model.js';
import type { PanelResult, TriageData } from './query.js';

/**
 * Markdown serializer for the triage cockpit (`pgops --snapshot`, and the `s`
 * key inside the cockpit). Pure: same TriageData in, same string out.
 *
 * Per-panel isolation is preserved end-to-end — a panel that failed to load
 * (no privilege for pg_replication_slots on RDS, say) renders as
 * `<name>: n/a (<error>)` while every other panel still renders its rows.
 */

/** ok → ✓; warn/critical → ⚠. One glyph, so a Slack paste reads at a glance. */
function mark(v: Verdict): string {
  return v.level === 'ok' ? '✓' : '⚠';
}

/** `## Blocked ⚠ — 4 pid(s) waiting`; the note is omitted when the verdict has none. */
function heading(title: string, v: Verdict): string {
  return `## ${title} ${mark(v)}${v.note ? ` — ${v.note}` : ''}`;
}

/** Escape a literal `|` so a query containing `||` can't shatter the table. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/**
 * Render one panel: its section when the query succeeded, a single `n/a` line
 * naming the error when it didn't. This is the only place a failed panel is
 * turned into text, so no caller can accidentally throw on `{ ok: false }`.
 */
function section<T>(name: string, title: string, p: PanelResult<T>, body: (data: T) => string[]): string[] {
  // No verdict glyph and no dangling em-dash: nothing was measured, so nothing
  // is asserted. The body carries the `n/a (error)` line, matching the HEALTH
  // cards' `- slots: n/a (…)` form.
  if (!p.ok) return [`## ${title}`, '', `${name}: n/a (${p.error})`, ''];
  return body(p.data);
}

export function triageToMarkdown(data: TriageData): string {
  const lines: string[] = [];

  lines.push(
    ...section('sessions', 'Sessions', data.sessions, (s) => [
      heading('Sessions', verdictSessions(s)),
      '',
      ...(s.byState.length === 0
        ? ['No client sessions.']
        : [
            '| state | sessions | longest in state |',
            '|---|---|---|',
            ...s.byState.map(
              (r) => `| ${cell(r.state)} | ${r.sessions} | ${formatDuration(r.longestInStateSecs)} |`,
            ),
          ]),
      '',
    ]),
  );

  lines.push(
    ...section('blocked', 'Blocked', data.blocked, (b) => [
      heading('Blocked', verdictBlocked(b)),
      '',
      b.blockedCount === 0
        ? 'Nothing blocked.'
        : `${b.blockedCount} session(s) waiting, longest ${formatDuration(b.longestWaitSecs)}` +
          (b.suspectPid == null ? '' : ` — suspect pid ${b.suspectPid}`),
      '',
    ]),
  );

  lines.push(
    ...section('long-running', 'Long-running', data.longRunning, (rows) => [
      heading('Long-running', verdictLongRunning(rows)),
      '',
      ...(rows.length === 0
        ? ['No queries running longer than 5s.']
        : [
            '| pid | running | query |',
            '|---|---|---|',
            ...rows.map((r) => `| ${r.pid} | ${formatDuration(r.runningSecs)} | ${cell(truncateQuery(r.query))} |`),
          ]),
      '',
    ]),
  );

  lines.push(
    ...section('connections', 'Connections', data.connections, (c) => [
      heading('Connections', verdictConnections(c)),
      '',
      `${c.used} / ${c.max} used — ${c.headroom} free`,
      '',
    ]),
  );

  // HEALTH: two one-line verdicts, not drillable panels (v0.1 scope).
  lines.push('## Health', '');
  lines.push(
    data.wraparound.ok
      ? `- ${mark(verdictWraparound(data.wraparound.data))} wraparound ${data.wraparound.data.pctOfHorizon}% of horizon` +
        noteSuffix(verdictWraparound(data.wraparound.data))
      : `- wraparound: n/a (${data.wraparound.error})`,
  );
  lines.push(
    data.slots.ok
      ? `- ${mark(verdictSlots(data.slots.data))} slots ${data.slots.data.inactiveCount} inactive` +
        noteSuffix(verdictSlots(data.slots.data))
      : `- slots: n/a (${data.slots.error})`,
  );
  lines.push('');

  return lines.join('\n');
}

/** ` — see dba-playbook/03` etc.; empty when the verdict is ok/noteless. */
function noteSuffix(v: Verdict): string {
  return v.note ? ` — ${v.note}` : '';
}
