import { describe, expect, it } from 'vitest';
import { flatten, listRows, readingAt, stripPaths, tiesOf } from '@/lib/rows';
import type { SessionNode, StatementNode, TableNode, Tree } from '@/lib/tree';

const session = (pid: number, over: Partial<SessionNode> = {}): SessionNode =>
  ({ pid, backendStart: `b${pid}`, app: 'web', spans: [], inChain: false, ...over });
const statement = (key: string, sessions: SessionNode[] = [], more = 0): StatementNode =>
  ({ key, text: key, strip: [], tables: ['public.users'], sessions, more, unplaced: false, callsPerSec: null, meanMs: null });
/** A table as the tree hands it over: open with its statements, or folded with none. */
const table = (name: string, statements: StatementNode[], more = 0, open = true): TableNode =>
  ({ name, strip: [], open, shapes: statements.length + more, statements: open ? statements : [], more: open ? more : 0, flags: [] });
const tree = (over: Partial<Tree>): Tree => ({
  from: 0, to: 1000, columns: 4, live: false, sessionsShown: true, seen: [1, 1, 1, 1], scale: 4, band: [], tables: [], tablesMore: 0, none: null,
  quiet: [], quietOpen: false, quietTotal: 0, findings: [], events: [], marks: { chainCriticalSecs: 60, idleWarnSecs: 60, idleCriticalSecs: 300 },
  hidden: false, truncated: false, empty: false, flat: [], flatMore: 0, ...over,
});
const kinds = (t: Tree) => flatten(t).map((r) => r.kind);

describe('flatten', () => {
  const users = (open: boolean) => table('public.users', [statement('upd', [session(1), session(2)], 4), statement('sel')], 7, open);

  it('shows folded tables as one row each, then the quiet count', () => {
    const t = tree({ tables: [users(false), table('public.orders', [statement('ins')], 0, false)], none: table('', [statement('begin')], 0, false), quietTotal: 12 });
    expect(kinds(t)).toEqual(['table', 'table', 'table', 'quiet']);
  });

  it('opens a table to its statements, their sessions and what is left uncounted', () => {
    const t = tree({ tables: [users(true), table('public.orders', [], 0, false)] });
    expect(kinds(t)).toEqual(['table', 'statement', 'session', 'session', 'more', 'statement', 'more', 'table']);
    expect(flatten(t).filter((r) => r.kind === 'more').map((r) => r.kind === 'more' && [r.what, r.count])).toEqual([['sessions', 4], ['statements', 7]]);
  });

  it('lists "not on any table" last among the tables, marked, and the quiet tables under their count', () => {
    const t = tree({
      tables: [users(false)], tablesMore: 30, none: table('', [statement('begin')]),
      quiet: [{ name: 'public.audit', sizeBytes: 9, liveRows: 1, flags: [] }], quietOpen: true, quietTotal: 12,
    });
    const rows = flatten(t);
    expect(rows.map((r) => r.kind)).toEqual(['table', 'more', 'table', 'statement', 'quiet', 'quiet-table']);
    expect(rows[1]).toMatchObject({ kind: 'more', what: 'tables', count: 30 });
    expect(rows[2]).toMatchObject({ kind: 'table', none: true });
    expect(rows[4]).toMatchObject({ kind: 'quiet', count: 12, open: true });
  });

  it('gives every row an id of its own, even a statement listed under two tables', () => {
    const shared = statement('join', [session(5)]);
    const ids = flatten(tree({ tables: [table('public.a', [shared]), table('public.b', [shared])] })).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no quiet row when there are no quiet tables', () => {
    expect(kinds(tree({ tables: [table('public.users', [])] }))).toEqual(['table']);
  });
});

describe('tiesOf', () => {
  const wait = (blockedBy: number, from: number) => [{ cls: 'lock' as const, from, to: 1000, blockedBy }];
  const chain = tree({
    tables: [table('public.users', [
      statement('upd', [session(1), session(3, { spans: wait(2, 500) })]),
      statement('del', [session(2, { spans: wait(1, 250) })]),
    ])],
  });
  const rows = flatten(chain);

  it('ties each waiter to its blocker\'s row at the moment the wait began', () => {
    // Rows: table, upd, 1, 3, del, 2.
    expect(tiesOf(rows, chain)).toEqual([{ at: 0.5, from: 3, to: 5 }, { at: 0.25, from: 5, to: 2 }]);
  });

  it('draws none for a waiter whose blocker has no row', () => {
    const lone = tree({ tables: [table('public.users', [statement('del', [session(2, { spans: wait(77, 250) })])])] });
    expect(tiesOf(flatten(lone), lone)).toEqual([]);
  });

  it('holds a tie that began before the window just inside its edge', () => {
    const early = tree({ tables: [table('public.users', [statement('q', [session(1), session(2, { spans: wait(1, -5000) })])])] });
    expect(tiesOf(flatten(early), early)[0]!.at).toBe(0.006);
  });

  it('ties a session listed under two tables once, from its first row', () => {
    const shared = statement('join', [session(1), session(2, { spans: wait(1, 100) })]);
    const two = tree({ tables: [table('public.a', [shared]), table('public.b', [shared])] });
    expect(tiesOf(flatten(two), two)).toHaveLength(1);
  });
});

describe('stripPaths', () => {
  it('stacks a column bottom up in class order on the scale', () => {
    // Two on CPU and one waiting on a lock, on a scale of 4.
    expect(stripPaths([[2, 0, 0, 0, 1]], 4)).toEqual(['M0 50h1v50h-1z', '', '', '', 'M0 25h1v25h-1z']);
  });

  it('lifts a small load to the floor so it is seen', () => {
    // 0.1 on a scale of 8 would be 1.25 of 100; the floor is 7.
    expect(stripPaths([[0.1, 0, 0, 0, 0]], 8)[0]).toBe('M0 93h1v7h-1z');
    expect(stripPaths([[0.1, 0, 0, 0, 0]], 8, 0)[0]).toBe('M0 98.75h1v1.25h-1z');
  });

  it('draws nothing for an empty column and clips one past the scale', () => {
    expect(stripPaths([[0, 0, 0, 0, 0], [9, 0, 0, 0, 0]], 4)).toEqual(['M1 0h1v100h-1z', '', '', '', '']);
  });

  it('reads a column back as numbers', () => {
    expect(readingAt([[2, 0, 0, 0, 1]], 0)).toEqual({ total: 3, byClass: [2, 0, 0, 0, 1] });
    expect(readingAt([], 3).total).toBe(0);
  });
});

describe('listRows', () => {
  const upd = statement('upd', [session(1), session(2)], 4);
  const sel = statement('sel');

  it('lists a population\'s statements at the left edge, each with its sessions', () => {
    const rows = listRows(tree({ flat: [upd, sel], flatMore: 9 }), { kind: 'statements' });
    expect(rows.map((r) => [r.kind, 'level' in r ? r.level : null])).toEqual([
      ['statement', 0], ['session', 1], ['session', 1], ['more', 1], ['statement', 0], ['more', 0],
    ]);
    expect(rows.at(-1)).toMatchObject({ what: 'statements', count: 9 });
    // On a flat list a statement row names its table itself.
    expect(rows[0]).toMatchObject({ table: null });
  });

  it('lists one table\'s statements with no row for the table', () => {
    const rows = listRows(tree({ tables: [table('public.users', [upd, sel], 2)] }), { kind: 'table', name: 'public.users' });
    expect(rows.map((r) => r.kind)).toEqual(['statement', 'session', 'session', 'more', 'statement', 'more']);
    expect(rows[0]).toMatchObject({ table: 'public.users' });
    expect(listRows(tree({}), { kind: 'table', name: 'public.gone' })).toEqual([]);
  });

  it('lists one statement\'s sessions alone', () => {
    const rows = listRows(tree({ flat: [upd] }), { kind: 'sessions', key: 'upd' });
    expect(rows.map((r) => [r.kind, 'level' in r ? r.level : null])).toEqual([['session', 0], ['session', 0], ['more', 0]]);
  });
});
