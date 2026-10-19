import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sample, SampleSession } from '@pgops/checks';
import { render, type Rendered } from './render';
import { Clock } from '@/components/clock';
import { RowsView, TreeView } from '@/components/tree-view';
import { gridFor } from '@/lib/clock';
import type { Show } from '@/lib/rows';
import { buildTree, type Pointer, type Tree, type TreeInput } from '@/lib/tree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const NOW = Date.UTC(2026, 9, 12, 8, 30, 0);
const MIN = 60_000;
const BUCKET = 15_000;
const CHAIN_AT = NOW - 5 * MIN;

const ses = (pid: number, over: Partial<SampleSession> = {}): SampleSession => ({
  pid, backendStart: `b${pid}`, app: 'web', cls: 'cpu', since: NOW - 15 * MIN, statement: '42',
  relations: ['public.users'], blockedBy: null, ...over,
});
/** Fifteen minutes of samples; for the last five, 2 waits on 1 and 3 waits on 2. */
const samples = (): Sample[] => [...Array(60)].map((_, i) => {
  const at = NOW - 15 * MIN + i * BUCKET;
  const chained = at >= CHAIN_AT;
  return {
    at, hidden: false, truncated: false,
    sessions: [
      ses(9, { relations: ['public.orders'], statement: 'tabc' }),
      ...(chained ? [
        ses(1, { cls: 'idle', since: CHAIN_AT - 2000 }),
        ses(2, { cls: 'lock', since: CHAIN_AT, blockedBy: 1, statement: '77' }),
        ses(3, { cls: 'lock', since: CHAIN_AT + 100, blockedBy: 2 }),
      ] : []),
    ],
  };
});
const grid = (sp: Record<string, string> = { win: '900' }) => gridFor(sp, NOW);
const tree = (over: Partial<TreeInput> = {}): Tree => {
  const g = grid();
  return buildTree({
    from: g.from, to: g.to, columns: g.columns, live: true, raw: g.raw, samples: samples(), cells: [], events: [],
    tables: [
      { name: 'public.users', sizeBytes: 9_000_000, liveRows: 50_000, flags: [] }, { name: 'public.orders', sizeBytes: 8_000_000, liveRows: 9000, flags: [] },
      { name: 'public.audit', sizeBytes: 5_000_000, liveRows: 1200, flags: [] },
    ],
    tablesTotal: 3,
    statements: new Map([['42', { text: 'UPDATE users SET n = $1', relations: [] }], ['77', { text: 'DELETE FROM users', relations: [] }], ['tabc', { text: 'BEGIN', relations: [] }]]),
    shapes: [], open: null, find: '', bucketMs: BUCKET, marks: { chainCriticalSecs: 60, idleWarnSecs: 60, idleCriticalSecs: 300 },
    ...over,
  });
};

let view: Rendered;
const mount = async (t: Tree, extra: {
  cursor?: number; actions?: boolean; pointers?: Pointer[]; kept?: 'store' | 'memory'; find?: string; sp?: Record<string, string>;
  catalog?: { at: number | null; failed: string | null }; storeFailed?: string;
} = {}) => {
  view = await render(
    <Clock grid={grid(extra.sp)} now={NOW} day={{ to: NOW, columns: [] }} events={[]} initialCursor={extra.cursor ?? null}>
      <TreeView
        database="prod" tree={t} find={extra.find ?? ''} pointers={extra.pointers ?? []}
        catalog={extra.catalog ?? { at: null, failed: null }}
        grant="GRANT pg_read_all_stats TO CURRENT_USER;" kept={extra.kept ?? 'store'} storeFailed={extra.storeFailed ?? null}
        actions={extra.actions ?? true}
      />
    </Clock>,
  );
};
const rowsOf = () => [...view.container.querySelectorAll('[role=row]')];
const rowWith = (text: string) => rowsOf().find((r) => r.textContent!.includes(text))!;
const terminates = (within: Element = view.container) => [...within.querySelectorAll('button')].filter((b) => b.textContent === 'Terminate');
const answer = () => view.container.querySelector('[role=status]');

beforeEach(() => { router.replace.mockClear(); });
afterEach(() => { view.unmount(); });

describe('the answer', () => {
  it('names the chain\'s root, its waiters and its table, with the one action that ends it', async () => {
    await mount(tree());
    expect(answer()!.textContent).toContain('1 blocks 2 on public.users');
    // A live page reads just inside the window's end.
    expect(answer()!.textContent).toContain('4m 59s');
    expect(terminates(answer()!)).toHaveLength(1);
    expect(answer()!.querySelector('a[href$="#pid-1"]')!.getAttribute('href')).toContain('open=public.users');
  });

  it('says a moment nobody sampled was not sampled, never that it needed nothing', async () => {
    // The sampler stopped ten minutes in: no sample after that.
    await mount(tree({ samples: samples().slice(0, 40) }), { cursor: NOW - 2 * MIN });
    expect(answer()).toBeNull();
    expect(view.text()).toContain('not sampled at');
    expect(view.text()).not.toContain('nothing needs attention');
  });

  it('links a pid to its row with its table opened, though the reader folded it', async () => {
    await mount(tree({ open: new Set(['public.orders']) }));
    const href = answer()!.querySelector('a[href$="#pid-1"]')!.getAttribute('href')!;
    expect(new URLSearchParams(href.split('#')[0]!.slice(1)).getAll('open')).toEqual(['public.orders', 'public.users']);
  });

  it('puts a session\'s Terminate before its duration, in a cell that clips sideways, so a phone can reach it', async () => {
    await mount(tree());
    const row = view.container.querySelector('#pid-1')!;
    const cell = row.querySelector('[role=rowheader]')!;
    // The clip is on an unpositioned wrapper, so the confirm placed against the cell escapes it.
    expect(cell.querySelector('[data-clip]')!.className).toContain('max-sm:overflow-x-clip');
    expect(cell.className).not.toContain('overflow');
    const text = cell.textContent!;
    expect(text.indexOf('Terminate')).toBeLessThan(text.search(/\d+m \d+s/));
  });

  it('has nothing to say, and nothing to press, two minutes before the chain', async () => {
    await mount(tree(), { cursor: CHAIN_AT - 2 * MIN });
    expect(answer()).toBeNull();
    expect(view.text()).toContain('nothing needs attention at');
    expect(terminates()).toHaveLength(0);
  });

  it('states a chain in the past as of that moment, with no action', async () => {
    await mount(tree(), { cursor: CHAIN_AT + MIN });
    expect(answer()!.textContent).toContain('1 blocks 2 on public.users');
    expect(answer()!.textContent).toContain('1m 0s');
    expect(terminates()).toHaveLength(0);
  });

  it('offers no action on a console that may not act', async () => {
    await mount(tree(), { actions: false });
    expect(answer()!.textContent).toContain('1 blocks 2');
    expect(terminates()).toHaveLength(0);
  });

  it('lists what the Server reads judged, at live only', async () => {
    const pointers = [{ label: 'transaction ID age', note: '212M', level: 'warn' as const, href: '/db/prod/cleanup' }];
    await mount(tree({ samples: [] }), { pointers });
    expect(answer()!.textContent).toContain('transaction ID age 212M');
    expect(answer()!.querySelector('a[href="/db/prod/cleanup"]')).not.toBeNull();
    view.unmount();
    await mount(tree({ samples: [] }), { pointers, cursor: NOW - 5 * MIN });
    expect(answer()).toBeNull();
  });
});

describe('the rows', () => {
  it('tags a statement no plan has placed', async () => {
    await mount(tree({
      shapes: [{ key: '99', text: 'SET search_path = app', relations: null, callsPerSec: 1, meanMs: 1 }],
      open: new Set(['(none)']),
    }));
    expect(rowWith('SET search_path').textContent).toContain('not placed');
  });

  it('opens the table the chain is on: both statements, the three sessions, and two ties', async () => {
    await mount(tree());
    expect(rowWith('public.users').querySelector('[aria-expanded="true"]')).not.toBeNull();
    expect(view.text()).toContain('UPDATE users SET n = $1');
    expect(view.text()).toContain('DELETE FROM users');
    expect([1, 2, 3].map((pid) => view.container.querySelector(`#pid-${pid}`) !== null)).toEqual([true, true, true]);
    expect(view.container.querySelectorAll('[data-tie]')).toHaveLength(2);
  });

  it('puts Terminate on the root\'s row and never on a waiter\'s', async () => {
    await mount(tree());
    expect(terminates(view.container.querySelector('#pid-1')!)).toHaveLength(1);
    expect(terminates(view.container.querySelector('#pid-2')!)).toHaveLength(0);
    expect(terminates(view.container.querySelector('#pid-3')!)).toHaveLength(0);
  });

  it('says what each session is doing and for how long, at the cursor', async () => {
    await mount(tree());
    expect(view.container.querySelector('#pid-1')!.textContent).toContain('idle in txn');
    expect(view.container.querySelector('#pid-2')!.textContent).toContain('lock wait4m 59s');
  });

  it('gives a row one link at most: its label cell', async () => {
    await mount(tree());
    for (const row of rowsOf()) expect(row.querySelectorAll('a').length, row.textContent!).toBeLessThanOrEqual(1);
    expect(rowWith('public.users').querySelector('a')!.getAttribute('href')).toBe('/db/prod/tables/public.users');
    expect(rowWith('UPDATE users').querySelector('a')!.getAttribute('href')).toBe('/db/prod/queries/42');
  });

  it('links no statement the statement page cannot show', async () => {
    await mount(tree({ open: new Set(['public.orders']) }));
    expect(rowWith('BEGIN').querySelector('a')).toBeNull();
  });

  /**
   * The mark and the answer read the same findings. A strip column covers
   * more than an instant, so read from the strip the mark would show a
   * column before the chain began, under an answer saying nothing was wrong.
   */
  it('never marks a table blocked at a moment the answer has no chain for', async () => {
    await mount(tree(), { cursor: CHAIN_AT - 1 });
    expect(answer()?.textContent ?? '').not.toContain('blocks');
    expect(rowWith('public.users').textContent).not.toContain('blocked');
  });

  it('offers no Terminate for a root it has no identity for', async () => {
    const t = tree();
    const blind = { ...t, findings: t.findings.map((f) => ({ ...f, backendStart: null })) };
    await mount(blind);
    expect(answer()!.textContent).toContain('blocks');
    expect(terminates(answer()!)).toHaveLength(0);
  });

  it('marks the table blocked while a session on it waits on a lock', async () => {
    await mount(tree());
    expect(rowWith('public.users').textContent).toContain('blocked');
    view.unmount();
    await mount(tree(), { cursor: CHAIN_AT - 2 * MIN });
    expect(rowWith('public.users').textContent).not.toContain('blocked');
  });

  it('asks the URL to open a fold, keeping the ones already open', async () => {
    await mount(tree());
    const caret = rowWith('public.orders').querySelector('button')!;
    await act(async () => { caret.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(router.replace).toHaveBeenCalledWith('?win=900&open=public.users&open=public.orders', { scroll: false });
  });

  it('counts the quiet tables in one row and names them when it is opened', async () => {
    await mount(tree());
    expect(rowWith('quiet table').textContent).toContain('1 quiet table');
    expect(view.text()).not.toContain('public.audit');
    view.unmount();
    await mount(tree({ open: new Set(['(quiet)']) }));
    expect(rowWith('public.audit').textContent).toContain('1,200 rows · 4.8 MB');
  });

  it('tags a table with what the catalog says of it, the chain first, two at most', async () => {
    await mount(tree({
      tables: [{ name: 'public.users', sizeBytes: 9_000_000, liveRows: 50_000, flags: ['vacuum overdue', 'xid age'] }],
      tablesTotal: 1,
    }));
    const users = rowWith('public.users').textContent!;
    expect(users).toContain('blocked');
    expect(users).toContain('vacuum overdue');
    expect(users).not.toContain('xid age');
  });

  it('exposes each row\'s depth', async () => {
    await mount(tree());
    expect(rowWith('public.users').getAttribute('aria-level')).toBe('1');
    expect(rowWith('UPDATE users').getAttribute('aria-level')).toBe('2');
    expect(view.container.querySelector('#pid-1')!.getAttribute('aria-level')).toBe('3');
  });
});

describe('what the page could not see', () => {
  it('says once that sessions are hidden, and what to run', async () => {
    const s = samples();
    s[s.length - 1] = { ...s.at(-1)!, hidden: true, truncated: true };
    await mount(tree({ samples: s }));
    expect(view.text()).toContain('GRANT pg_read_all_stats TO CURRENT_USER;');
    expect(view.text()).toContain('Only the first 500 sessions were read.');
  });

  it('says the clock is short when there is no store and the window is wider than it holds', async () => {
    await mount(tree(), { kept: 'memory' });
    expect(view.text()).not.toContain('No store is configured');
    view.unmount();
    const g = grid({ win: '3600' });
    await mount(tree({ from: g.from, to: g.to }), { kept: 'memory', sp: { win: '3600' } });
    expect(view.text()).toContain('No store is configured, so the clock holds the last 15 minutes.');
  });

  it('says the store is not answering rather than that there is none', async () => {
    await mount(tree(), { kept: 'memory', storeFailed: 'connect ECONNREFUSED' });
    expect(view.text()).toContain('The store is not answering, so the clock holds this process’s last 15 minutes: connect ECONNREFUSED');
    expect(view.text()).not.toContain('No store is configured');
  });

  it('still shows what the server under an empty database is doing', async () => {
    await mount(tree({ samples: [], tables: [], tablesTotal: 0 }), {
      pointers: [{ label: 'transaction ID age', note: '212M transactions old', level: 'warn', href: '/db/prod/cleanup' }],
    });
    expect(view.text()).toContain('212M transactions old');
    expect(view.text()).toContain('This database has no tables and no sessions.');
  });

  it('says when the catalog could not be read, and when what it shows was read', async () => {
    await mount(tree(), { catalog: { at: NOW - 60_000, failed: 'statement timeout' } });
    expect(view.text()).toContain('The catalog could not be read: statement timeout');
    expect(view.text()).toMatch(/tables as of \d\d:\d\d:\d\d/);
  });

  it('says an empty database is empty, and a find that found nothing found nothing', async () => {
    await mount(tree({ samples: [], tables: [], tablesTotal: 0 }));
    expect(view.text()).toContain('This database has no tables and no sessions.');
    view.unmount();
    await mount(tree({ find: 'zzz' }), { find: 'zzz' });
    expect(view.text()).toContain('nothing named “zzz”');
  });
});

describe('rows with no band', () => {
  const flat = (over: Partial<TreeInput> = {}) => tree({ flat: 10, open: new Set(), ...over });
  const list = async (t: Tree, show: Show) => {
    view = await render(
      <Clock grid={grid()} now={NOW} day={{ to: NOW, columns: [] }} events={[]}>
        <RowsView database="prod" tree={t} show={show} actions />
      </Clock>,
    );
  };

  it('lists statements flat under a key of the five classes, each naming its table', async () => {
    await list(flat(), { kind: 'statements' });
    expect(view.text()).toContain('Lock wait');
    expect(rowWith('UPDATE users SET n').getAttribute('aria-level')).toBe('1');
    // The statement on public.orders says so itself: no table row stands above it.
    expect(rowWith('BEGIN').textContent).toContain('orders');
  });

  it('prints calls a second and the mean where the snapshots hold them', async () => {
    await list(flat({ shapes: [{ key: '42', text: 'UPDATE users SET n = $1', relations: ['public.users'], callsPerSec: 12.4, meanMs: 3.2 }] }), { kind: 'statements' });
    expect(rowWith('UPDATE users SET n').textContent).toContain('12 calls/s · 3.2ms each');
    expect(rowWith('DELETE FROM users').textContent).not.toContain('calls/s');
  });

  it('lists one statement\'s sessions with Terminate on the root and never on a waiter', async () => {
    await list(tree({ only: '42', sessionsMax: 200 }), { kind: 'sessions', key: '42' });
    expect(view.text()).toContain('in this state for');
    expect(rowsOf().every((r) => r.getAttribute('aria-level') === '1')).toBe(true);
    expect(terminates(view.container.querySelector('#pid-1')!)).toHaveLength(1);
    expect(terminates(view.container.querySelector('#pid-3')!)).toHaveLength(0);
  });
});
