import type { PlanNode } from '@pgops/checks';

/**
 * Ported in spirit from the TUI's formatDuration. Hours drop seconds because a
 * 27-hour transaction's second count is noise, and the column it sits in is
 * narrow on every surface that renders it.
 */
export function formatDuration(secs: number | null): string {
  if (secs === null) return '—';
  const s = Math.max(0, Math.floor(secs));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/**
 * Durations that arrive in MILLISECONDS, which is what pg_stat_statements
 * reports and what the Queries page ranks by.
 *
 * `formatDuration` cannot do this job. It floors to whole seconds, so every
 * query mean below a second — which is very nearly all of them — rendered as
 * "0s": the column the page sorts by was unreadable for the ordinary case.
 * Dividing by 1000 and reusing the seconds formatter was itself a fix for the
 * opposite bug (a 250ms value read as seconds rendered "250h 0m"); it cured
 * the overflow and produced this.
 *
 * Precision falls as magnitude rises, because that is how the number is read:
 * a tenth of a millisecond matters at 3ms and is noise at 3 minutes.
 */
export function formatMillis(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return '0ms';
  // Anything faster than this is below the resolution worth printing, and
  // "0ms" would read as "free" for a statement that did do work.
  if (ms < 0.1) return '<0.1ms';
  if (ms < 100) return `${Number(ms.toFixed(1))}ms`;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(1))}s`;
  return formatDuration(ms / 1_000);
}

/**
 * Byte counts, for WAL retained by a replication slot.
 *
 * Binary units, because that is what Postgres reports and what its own
 * settings use — `max_slot_wal_keep_size` is written in MB meaning 2^20, and
 * a console that printed 1.05 GB where the server means 1 GiB would be
 * inviting an off-by-7% comparison against the setting the operator is about
 * to change.
 *
 * The suffixes stay the familiar KB/MB/GB rather than KiB/MiB/GiB, matching
 * `pg_size_pretty`, which is the string this number will be compared against
 * in psql two minutes later.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const n = Math.max(0, bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below ten, none above: "1.2 GB" is a different quantity from
  // "1.9 GB" to someone deciding whether to drop a slot, while "847 MB" and
  // "847.3 MB" are the same decision.
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)} ${units[unit]}`;
}

/**
 * A byte DELTA, signed.
 *
 * `formatBytes` clamps to zero — correct for a size, which cannot be
 * negative, and wrong for growth, which routinely is: VACUUM FULL, a dropped
 * index and a detached partition all shrink a relation, and an operator who
 * has just done one of those needs to see that it worked. Sign carried
 * explicitly, magnitude formatted by `formatBytes` so the two agree on units.
 */
export function formatDelta(bytes: number): string {
  if (bytes === 0) return '0 B';
  return `${bytes < 0 ? '−' : '+'}${formatBytes(Math.abs(bytes))}`;
}

const PLAN_DETAILS = [
  'Index Cond', 'Recheck Cond', 'Hash Cond', 'Merge Cond', 'Join Filter',
  'Filter', 'One-Time Filter', 'Sort Key', 'Group Key',
] as const;

const AGGREGATE: Record<string, string> = { Sorted: 'GroupAggregate', Hashed: 'HashAggregate', Mixed: 'MixedAggregate' };

/** Postgres's `quote_identifier`, minus its keyword list: bare when plainly an identifier. */
const ident = (id: string) => (/^[a-z_][a-z0-9_$]*$/.test(id) ? id : `"${id.replace(/"/g, '""')}"`);

/**
 * A node's name as text EXPLAIN prints it. JSON splits it across fields —
 * `"Node Type": "Hash Join"` with `"Join Type": "Left"` is a Hash LEFT Join —
 * and printing the node type alone turns a left join into an inner one and an
 * anti join into a plain nested loop: a different query. Transcribed from
 * explain.c's ExplainNode and held to real output by plan-lines.test.ts.
 */
function nodeName(node: PlanNode, str: (k: string) => string | undefined): string {
  const type = node['Node Type'];
  let name = type;
  if (type === 'ModifyTable') name = str('Operation') ?? type;
  else if (type === 'Aggregate') name = AGGREGATE[str('Strategy') ?? ''] ?? type;
  else if (type === 'SetOp') {
    name = `${str('Strategy') === 'Hashed' ? 'HashSetOp' : 'SetOp'}${str('Command') ? ` ${str('Command')}` : ''}`;
  }
  const partial = str('Partial Mode');
  if (partial === 'Partial' || partial === 'Finalize') name = `${partial} ${name}`;
  if (node['Parallel Aware'] === true) name = `Parallel ${name}`;
  const join = str('Join Type');
  if (join !== undefined && join !== 'Inner') {
    name = type === 'Nested Loop' ? `${name} ${join} Join` : `${name.replace(/ Join$/, '')} ${join} Join`;
  }
  if (str('Scan Direction') === 'Backward') name += ' Backward';
  return name;
}

/**
 * What a node reads: `using <index>` and `on [schema.]object [alias]`, the
 * alias only where it differs — explain.c's ExplainScanTarget. A Bitmap Index
 * Scan reads the index itself, so it is `on` the index.
 */
function target(node: PlanNode, str: (k: string) => string | undefined): string {
  const index = str('Index Name');
  if (index !== undefined && node['Node Type'] === 'Bitmap Index Scan') return ` on ${ident(index)}`;
  const object = str('Relation Name') ?? str('Function Name') ?? str('CTE Name') ?? str('Tuplestore Name');
  const alias = str('Alias');
  const schema = str('Schema');
  let out = index === undefined ? '' : ` using ${ident(index)}`;
  if (object === undefined && alias === undefined) return out;
  out += ' on';
  if (object !== undefined) out += ` ${schema === undefined ? '' : `${ident(schema)}.`}${ident(object)}`;
  if (alias !== undefined && alias !== object) out += ` ${ident(alias)}`;
  return out;
}

/**
 * A JSON plan as the indented text an operator already reads.
 *
 * pgops plans as JSON because index advice needs the structure — which node
 * scans which relation with which filter. The person reading the plan needs
 * the shape `EXPLAIN` has printed for decades, so this reproduces it: six
 * columns of indent per level, `->` before every child, details two past the
 * node they belong to, and an InitPlan or SubPlan under its own name, its
 * subtree two further in. Node lines match real output exactly
 * (plan-lines.test.ts); the details are a subset, with no `Output:`.
 */
export function planLines(node: PlanNode, depth = 0, pad = 0): string[] {
  const indent = depth === 0 ? '' : `${' '.repeat(6 * (depth - 1) + 2 + pad)}->  `;
  const detailIndent = ' '.repeat(6 * depth + 2 + pad);
  const str = (k: string) => (typeof node[k] === 'string' ? (node[k] as string) : undefined);
  const num = (k: string) => (typeof node[k] === 'number' ? (node[k] as number) : undefined);

  const total = num('Total Cost');
  const cost = total === undefined ? ''
    : `  (cost=${(num('Startup Cost') ?? 0).toFixed(2)}..${total.toFixed(2)}`
      + ` rows=${num('Plan Rows') ?? 0} width=${num('Plan Width') ?? 0})`;

  const lines = [`${indent}${nodeName(node, str)}${target(node, str)}${cost}`];
  for (const key of PLAN_DETAILS) {
    const value = node[key];
    if (typeof value === 'string') lines.push(`${detailIndent}${key}: ${value}`);
    else if (Array.isArray(value)) lines.push(`${detailIndent}${key}: ${value.join(', ')}`);
  }
  for (const child of node.Plans ?? []) {
    const subplan = typeof child['Subplan Name'] === 'string' ? child['Subplan Name'] : undefined;
    if (subplan === undefined) lines.push(...planLines(child, depth + 1, pad));
    else lines.push(`${detailIndent}${subplan}`, ...planLines(child, depth + 1, pad + 2));
  }
  return lines;
}
