import { formatDuration, type RootBlocker, type Waiter, waiterAppBreakdown } from './chain.js';
import { adviseBlocker } from './advise.js';
import { truncateQuery } from '../../core/format.js';

/** Markdown body for the snapshot exporter (plan §A1: snapshots include the chain). */
export function chainsToMarkdown(roots: RootBlocker[]): string {
  if (roots.length === 0) return '_No lock contention. The DB is not blocked._';

  const lines: string[] = [];
  for (const root of roots) {
    lines.push(
      `## Root blocker: pid ${root.pid} (${root.user ?? '?'}@${root.app ?? '?'}) — held ${formatDuration(root.heldForSecs)}`,
    );
    lines.push(`- holds **${root.heldMode ?? '?'}**, blocking ${root.totalWaiters} session(s)`);
    lines.push(`- state: **${root.state ?? '?'}**`);
    const breakdown = waiterAppBreakdown(root.waiters)
      .map((b) => `${b.app}×${b.count}`)
      .join(', ');
    if (breakdown) lines.push(`- waiting: ${breakdown}`);
    const advice = adviseBlocker(root);
    lines.push(`- advise: _${advice.text}_`);
    // `truncateQuery` now redacts before it truncates (core/format.ts, I3), so a
    // credential can't be split past the 200-char cut and escape the envelope's
    // redaction. Escape backticks so a query containing one can't break out of
    // the markdown code span.
    const safeQuery = truncateQuery(root.query, 200).replace(/`/g, "'");
    lines.push(`- query: \`${safeQuery}\``);
    const walk = (waiters: Waiter[], depth: number) => {
      for (const w of waiters) {
        const indent = '  '.repeat(depth);
        const cycle = w.cycle ? ' ⚠️ cycle' : '';
        lines.push(
          `${indent}- pid ${w.pid} (${w.user ?? '?'}@${w.app ?? '?'}) waiting **${w.waitingMode ?? '?'}** on ${w.table ?? '?'} for ${formatDuration(w.waitingForSecs)}${cycle}`,
        );
        walk(w.waiters, depth + 1);
      }
    };
    walk(root.waiters, 1);
    lines.push('');
  }
  return lines.join('\n');
}
