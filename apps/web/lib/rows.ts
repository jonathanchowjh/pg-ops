import { round2 } from './format';
import { FOLD_NONE, type SessionNode, type StatementNode, type Strip, type TableFact, type TableNode, type Tree } from './tree';

/**
 * What the tree view draws, worked out where a test can reach it: the rows
 * in order with the folds applied, the ties between them, and a strip as
 * SVG paths. The components render these and decide nothing.
 */

type FlatRow =
  | { kind: 'table'; id: string; table: TableNode; none: boolean }
  | { kind: 'statement'; id: string; level: 0 | 1; statement: StatementNode; table: string | null }
  | { kind: 'session'; id: string; level: 0 | 1 | 2; session: SessionNode; statement: string }
  | { kind: 'more'; id: string; level: 0 | 1 | 2; count: number; what: 'tables' | 'statements' | 'sessions'; statement: string | null }
  | { kind: 'quiet'; id: string; open: boolean; count: number }
  | { kind: 'quiet-table'; id: string; fact: TableFact };

/** The visible rows, top to bottom. The tree has already applied the folds. */
export function flatten(tree: Tree): FlatRow[] {
  const out: FlatRow[] = [];
  const add = (table: TableNode, none: boolean): void => {
    const key = none ? FOLD_NONE : table.name;
    out.push({ kind: 'table', id: `t:${key}`, table, none });
    if (!table.open) return;
    for (const statement of table.statements) {
      out.push({ kind: 'statement', id: `q:${key}:${statement.key}`, level: 1, statement, table: table.name });
      for (const session of statement.sessions) {
        out.push({
          kind: 'session', id: `s:${key}:${statement.key}:${session.pid}/${session.backendStart}`,
          level: 2, session, statement: statement.key,
        });
      }
      if (statement.more > 0) {
        out.push({ kind: 'more', id: `m:${key}:${statement.key}`, level: 2, count: statement.more, what: 'sessions', statement: statement.key });
      }
    }
    if (table.more > 0) out.push({ kind: 'more', id: `m:${key}`, level: 1, count: table.more, what: 'statements', statement: null });
  };
  for (const t of tree.tables) add(t, false);
  if (tree.tablesMore > 0) out.push({ kind: 'more', id: 'm:tables', level: 0, count: tree.tablesMore, what: 'tables', statement: null });
  if (tree.none !== null) add(tree.none, true);
  if (tree.quietTotal > 0) {
    out.push({ kind: 'quiet', id: 'quiet', open: tree.quietOpen, count: tree.quietTotal });
    for (const fact of tree.quiet) out.push({ kind: 'quiet-table', id: `quiet:${fact.name}`, fact });
  }
  return out;
}

/** What a list that is not the tree shows. */
export type Show = { kind: 'statements' } | { kind: 'table'; name: string } | { kind: 'sessions'; key: string };

/**
 * The rows of a population's statements, of one table's, or of one
 * statement's sessions: the tree's nodes with no table row above them.
 * `table` is null on the flat list, where a statement row names its table.
 */
export function listRows(tree: Tree, show: Show): FlatRow[] {
  const out: FlatRow[] = [];
  const sessions = (statement: StatementNode, level: 0 | 1): void => {
    for (const session of statement.sessions) {
      out.push({ kind: 'session', id: `s:${statement.key}:${session.pid}/${session.backendStart}`, level, session, statement: statement.key });
    }
    if (statement.more > 0) out.push({ kind: 'more', id: `m:${statement.key}`, level, count: statement.more, what: 'sessions', statement: statement.key });
  };
  if (show.kind === 'sessions') {
    const statement = tree.flat.find((s) => s.key === show.key);
    if (statement !== undefined) sessions(statement, 0);
    return out;
  }
  const table = show.kind === 'table'
    ? [...tree.tables, ...(tree.none === null ? [] : [tree.none])].find((t) => t.name === show.name)
    : undefined;
  for (const statement of show.kind === 'statements' ? tree.flat : table?.statements ?? []) {
    out.push({ kind: 'statement', id: `q:${statement.key}`, level: 0, statement, table: show.kind === 'table' ? show.name : null });
    sessions(statement, 1);
  }
  const more = show.kind === 'statements' ? tree.flatMore : table?.more ?? 0;
  if (more > 0) out.push({ kind: 'more', id: 'm:statements', level: 0, count: more, what: 'statements', statement: null });
  return out;
}

export interface Tie { at: number; from: number; to: number }

/**
 * One tie per waiter: from its row to its blocker's, at the moment the wait
 * began. `at` is the way across the window, held just inside its edges;
 * `from` and `to` are row indexes. A waiter whose blocker has no row gets
 * none. A session listed under several tables is tied from its first row.
 */
export function tiesOf(rows: readonly FlatRow[], tree: Pick<Tree, 'from' | 'to'>): Tie[] {
  const rowOf = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.kind === 'session' && !rowOf.has(r.session.pid)) rowOf.set(r.session.pid, i);
  });
  const out: Tie[] = [];
  const tied = new Set<number>();
  rows.forEach((r, i) => {
    if (r.kind !== 'session' || tied.has(r.session.pid)) return;
    const wait = [...r.session.spans].reverse().find((p) => p.cls === 'lock' && p.blockedBy !== null);
    if (wait === undefined) return;
    const to = rowOf.get(wait.blockedBy!);
    if (to === undefined || to === i) return;
    tied.add(r.session.pid);
    const at = (wait.from - tree.from) / (tree.to - tree.from);
    out.push({ at: Math.max(0.006, Math.min(0.994, at)), from: i, to });
  });
  return out;
}


/**
 * A strip as one SVG path per class, in a box `strip.length` wide and 100
 * tall with y running down. Columns stack bottom up in class order on
 * `scale`. With `floor`, a load under that share of the scale is lifted to
 * it, so one session on a busy page still shows; the band passes 0.
 */
export function stripPaths(strip: Strip, scale: number, floor = 0.07): string[] {
  const d = ['', '', '', '', ''];
  strip.forEach((col, c) => {
    const total = col[0]! + col[1]! + col[2]! + col[3]! + col[4]!;
    if (total < 0.005) return;
    const lift = total < scale * floor ? (scale * floor) / total : 1;
    let y = 100;
    col.forEach((v, i) => {
      const h = Math.min(y, ((v * lift) / scale) * 100);
      if (h <= 0) return;
      y -= h;
      d[i] += `M${c} ${round2(y)}h1v${round2(h)}h-1z`;
    });
  });
  return d;
}

/** A strip's reading in one column: the total, then each class. */
export function readingAt(strip: Strip, col: number): { total: number; byClass: number[] } {
  const byClass = strip[col] ?? [0, 0, 0, 0, 0];
  return { total: byClass.reduce((a, b) => a + b, 0), byClass };
}
