import { describe, expect, it } from 'vitest';
import type { HealthMinute, Sample, SampleSession, StatementInfo } from '@pgops/checks';
import {
  FOLD_NONE, FOLD_QUIET, QUIET_SHOWN, STATEMENTS_SHOWN, TABLES_SHOWN, buildTree, findingsAt, roundUp, scaleSteps,
  type Shape, type Strip, type Tree, type TreeInput,
} from '@/lib/tree';

const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);
const MIN = 60_000;
const BUCKET = 15_000;
const MARKS = { chainCriticalSecs: 60, idleWarnSecs: 60, idleCriticalSecs: 300, headroomWarnPct: 20, headroomCriticalPct: 10, lagWarnSecs: 30, lagCriticalSecs: 300, xidWarnAge: 1_647_483_647, xidCriticalAge: 2_047_483_647 };

const ses = (pid: number, over: Partial<SampleSession> = {}): SampleSession => ({
  pid, backendStart: `b${pid}`, app: 'web', cls: 'cpu', since: T0, statement: 'q1',
  relations: ['public.users'], blockedBy: null, ...over,
});
/** Sample number `i` of the window: fifteen seconds apart from T0. */
const sample = (i: number, sessions: SampleSession[], over: Partial<Sample> = {}): Sample =>
  ({ at: T0 + i * BUCKET, sessions, hidden: false, truncated: false, ...over });
const texts = (entries: Record<string, string>): Map<string, StatementInfo> =>
  new Map(Object.entries(entries).map(([k, text]) => [k, { text, relations: [] }]));
/** Fifteen minutes from T0 in 60 columns: one column per bucket. */
const input = (over: Partial<TreeInput> = {}): TreeInput => ({
  from: T0, to: T0 + 15 * MIN, columns: 60, live: false, raw: true, samples: [], cells: [], events: [],
  tables: [], tablesTotal: 0, statements: new Map(), shapes: [], open: null, find: '', bucketMs: BUCKET, marks: MARKS, ...over,
});
const total = (s: Strip, col: number): number => s[col]!.reduce((a, b) => a + b, 0);

describe('roundUp', () => {
  it.each([[0, 1], [0.102, 0.12], [1, 1], [3.98, 4], [7, 8], [41, 50]])('%d rounds up to %d', (max, top) => {
    expect(roundUp(max)).toBe(top);
  });

  it('rules the axis in round steps from zero', () => {
    expect(scaleSteps(7)).toEqual([0, 2, 4, 6, 8]);
    expect(scaleSteps(0.102)).toEqual([0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12]);
    expect(scaleSteps(0)).toEqual([0, 1]);
  });
});

describe('placement', () => {
  it('puts a session under the table it locks and the statement it runs', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1)])], statements: texts({ q1: 'UPDATE users' }) }));
    expect(tree.tables.map((t) => t.name)).toEqual(['public.users']);
    expect(tree.tables[0]!.statements.map((s) => [s.key, s.text])).toEqual([['q1', 'UPDATE users']]);
    expect(total(tree.tables[0]!.strip, 0)).toBe(1);
    expect(total(tree.band, 0)).toBe(1);
  });

  // Review Focus 1.
  it('keeps a session that locks nothing: under "not on any table", in its strip and in the band', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1, { cls: 'idle', relations: [], statement: 'begin' })])] }));
    expect(tree.tables).toEqual([]);
    // With no table to open, the default opens nothing; the strip is there either way.
    expect(tree.none).toMatchObject({ open: false, shapes: 1 });
    expect(tree.none!.strip[0]).toEqual([0, 0, 1, 0, 0]);
    expect(tree.band[0]).toEqual([0, 0, 1, 0, 0]);
  });

  // Review Focus 2.
  it('lists a statement on three tables under each, and counts its session once per level', () => {
    const on = ['public.a', 'public.b', 'public.c'];
    const tree = buildTree(input({ samples: [sample(0, [ses(1, { relations: on })])], open: new Set(on) }));
    expect(tree.tables.map((t) => t.name).sort()).toEqual(on);
    for (const t of tree.tables) {
      expect(t.statements.map((s) => s.key)).toEqual(['q1']);
      expect(t.statements[0]!.tables).toEqual(on);
      expect(total(t.strip, 0)).toBe(1);
    }
    expect(total(tree.band, 0)).toBe(1);
    expect(total(tree.tables[0]!.statements[0]!.strip, 0)).toBe(1);
  });

  it('shows a table\'s busiest shapes and counts the rest', () => {
    const many = [...Array(200)].map((_, i) => ses(i + 1, { statement: `q${i}` }));
    const tree = buildTree(input({ samples: [sample(0, many)] }));
    expect(tree.tables[0]!.statements).toHaveLength(STATEMENTS_SHOWN);
    expect(tree.tables[0]!.more).toBe(200 - STATEMENTS_SHOWN);
    // The table's strip still counts all two hundred.
    expect(total(tree.tables[0]!.strip, 0)).toBe(200);
  });

  it('keeps a session whose statement this role cannot read', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1, { statement: null })])] }));
    expect(tree.tables[0]!.statements.map((s) => [s.key, s.text])).toEqual([['', null]]);
  });

  it('carries a table\'s flags onto its node, hot or quiet, and none for a table the catalog left out', () => {
    const tree = buildTree(input({
      samples: [sample(0, [ses(1), ses(2, { relations: ['public.unknown'] })])],
      tables: [
        { name: 'public.users', sizeBytes: 9, liveRows: 1, flags: ['vacuum overdue'] },
        { name: 'public.audit', sizeBytes: 5, liveRows: 1, flags: ['full scans'] },
      ],
      tablesTotal: 2, open: new Set(['(quiet)']),
    }));
    expect(tree.tables.map((t) => [t.name, t.flags])).toEqual([['public.unknown', []], ['public.users', ['vacuum overdue']]]);
    expect(tree.quiet.map((t) => [t.name, t.flags])).toEqual([['public.audit', ['full scans']]]);
  });
});

describe('strips', () => {
  it('holds a sample until the next one, so columns narrower than a bucket are not striped', () => {
    // 120 columns over 15 minutes are 7.5 s wide: two per bucket.
    const samples = [...Array(60)].map((_, i) => sample(i, [ses(1)]));
    const tree = buildTree(input({ columns: 120, samples }));
    for (let c = 0; c < 120; c += 1) expect(total(tree.band, c)).toBeCloseTo(1);
  });

  it('averages the samples a wide column covers', () => {
    // 15 columns of one minute; the session is in two of the first minute's four samples.
    const tree = buildTree(input({ columns: 15, samples: [sample(0, [ses(1)]), sample(1, [ses(1)]), sample(2, []), sample(3, [])] }));
    expect(total(tree.band, 0)).toBeCloseTo(0.5);
  });

  it('does not stretch the last sample past one bucket when pgops stopped sampling', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1)])] }));
    expect(total(tree.band, 0)).toBe(1);
    expect(total(tree.band, 1)).toBe(0);
  });

  it('shares one scale: the hottest row\'s peak, rounded up', () => {
    const tree = buildTree(input({ samples: [sample(0, [...Array(7)].map((_, i) => ses(i + 1)))] }));
    expect(tree.scale).toBe(8);
  });

  it('reads the live sample, not the bucket before it, in the newest column', () => {
    const to = T0 + 15 * MIN;
    const gone = buildTree(input({ live: true, samples: [sample(0, [ses(1)], { at: to - 10_000 }), sample(0, [], { at: to })], statements: texts({ q1: 'UPDATE users' }) }));
    expect(total(gone.tables.find((t) => t.name === 'public.users')!.strip, 59)).toBe(0);
    const here = buildTree(input({ live: true, samples: [sample(0, [], { at: to - 10_000 }), sample(0, [ses(1)], { at: to })], statements: texts({ q1: 'UPDATE users' }) }));
    expect(total(here.tables.find((t) => t.name === 'public.users')!.strip, 59)).toBe(1);
    expect(here.seen[59]).toBe(1);
  });

  /** Guard: a 12-minute column drawn from one instant would be a lie of its own. */
  it('keeps the rollup\'s mean in the newest column of a wide window', () => {
    const to = T0 + 6 * 60 * MIN;
    const cell = { col: 59, kind: 't' as const, key: 'public.users', cls: 'cpu' as const, sessions: 3 };
    const tree = buildTree(input({
      to, columns: 60, live: true, raw: false, cells: [cell], coverage: Array(60).fill(1),
      samples: [sample(0, [], { at: to })], statements: texts({ q1: 'UPDATE users' }),
      tables: [{ name: 'public.users', sizeBytes: 1, liveRows: 0, flags: [] }], tablesTotal: 1,
    }));
    expect(total(tree.tables.find((t) => t.name === 'public.users')!.strip, 59)).toBe(3);
    expect(tree.seen[59]).toBe(1);
  });
});

describe('folds', () => {
  const two = (open: Set<string> | null) => buildTree(input({
    open,
    samples: [sample(0, [ses(1), ses(2), ses(3, { relations: ['public.orders'], statement: 'q2' }), ses(4, { relations: [], statement: 'begin' })])],
    tables: ['public.users', 'public.orders', 'public.audit'].map((name) => ({ name, sizeBytes: 1, liveRows: 0, flags: [] })), tablesTotal: 3,
  }));

  it('opens the hottest table when the URL says nothing', () => {
    expect(two(null).tables.map((t) => [t.name, t.open, t.statements.length])).toEqual([['public.users', true, 1], ['public.orders', false, 0]]);
  });

  it('opens what the URL names and nothing else, and still counts a folded table\'s shapes', () => {
    const tree = two(new Set(['public.orders']));
    expect(tree.tables.map((t) => [t.name, t.open, t.shapes])).toEqual([['public.users', false, 1], ['public.orders', true, 1]]);
    expect(two(new Set()).tables.every((t) => !t.open)).toBe(true);
  });

  it('folds "not on any table" and the quiet tables the same way', () => {
    expect(two(null)).toMatchObject({ none: { open: false, statements: [] }, quietOpen: false, quiet: [], quietTotal: 1 });
    const open = two(new Set([FOLD_NONE, FOLD_QUIET]));
    expect(open.none!.statements.map((s) => s.key)).toEqual(['begin']);
    expect(open.quiet.map((t) => t.name)).toEqual(['public.audit']);
  });

  it('keeps one scale whatever is folded', () => {
    expect(two(new Set()).scale).toBe(two(new Set(['public.users', 'public.orders'])).scale);
  });

  it('opens the table a finding is on, ahead of a hotter one', () => {
    const tree = buildTree(input({
      samples: [sample(0, [
        ...[...Array(9)].map((_, i) => ses(20 + i, { relations: ['public.busy'] })),
        ses(1, { cls: 'idle' }), ses(2, { cls: 'lock', blockedBy: 1 }),
      ])],
    }));
    expect(tree.tables.map((t) => [t.name, t.open])).toEqual([['public.busy', false], ['public.users', true]]);
  });

  it('lists a hundred hot tables and counts the rest', () => {
    const many = [...Array(130)].map((_, i) => ses(i + 1, { relations: [`public.t${String(i).padStart(3, '0')}`] }));
    const tree = buildTree(input({ samples: [sample(0, many)] }));
    expect(tree.tables).toHaveLength(TABLES_SHOWN);
    expect(tree.tablesMore).toBe(30);
  });
});

describe('order', () => {
  const busy = (i: number) => sample(i, [ses(1, { relations: ['public.hot'] }), ses(2, { relations: ['public.hot'], statement: 'q2' }), ses(3, { relations: ['public.cool'] })]);

  it('sorts tables by load over the window, hottest first', () => {
    const tree = buildTree(input({ samples: [busy(0), busy(1)] }));
    expect(tree.tables.map((t) => t.name)).toEqual(['public.hot', 'public.cool']);
  });

  it('ignores the open minute, so a live page reorders when a minute closes and not on each poll', () => {
    // Four closed minutes of `cool`, then a burst on `hot` inside the minute still open at `to`.
    const to = T0 + 4 * MIN + 30_000;
    const closed = [...Array(16)].map((_, i) => sample(i, [ses(3, { relations: ['public.cool'] })]));
    const burst = [16, 17].map((i) => sample(i, [...Array(50)].map((_, k) => ses(100 + k, { relations: ['public.hot'] }))));
    const tree = buildTree(input({ to, columns: 18, live: true, samples: [...closed, ...burst] }));
    expect(tree.tables.map((t) => t.name)).toEqual(['public.cool', 'public.hot']);
  });

  it('puts the root\'s statement first, then the waiters\', then the rest by load', () => {
    const tree = buildTree(input({
      samples: [sample(0, [
        ses(1, { statement: 'root', cls: 'idle' }),
        ses(2, { statement: 'waits', cls: 'lock', blockedBy: 1 }),
        ...[...Array(5)].map((_, i) => ses(10 + i, { statement: 'busy' })),
      ])],
    }));
    expect(tree.tables[0]!.statements.map((s) => s.key)).toEqual(['root', 'waits', 'busy']);
  });
});

describe('sessions', () => {
  it('lists a session after thirty seconds in one state, and only counts a shorter one', () => {
    const tree = buildTree(input({
      samples: [0, 1, 2].map((i) => sample(i, i === 0 ? [ses(1), ses(2)] : [ses(1)])),
    }));
    const q = tree.tables[0]!.statements[0]!;
    expect(q.sessions.map((s) => s.pid)).toEqual([1]);
    expect(q.sessions[0]!.spans).toEqual([{ cls: 'cpu', from: T0, to: T0 + 3 * BUCKET, blockedBy: null }]);
  });

  it('starts a new span when the state changes, and ends the old one where the new began', () => {
    const tree = buildTree(input({
      samples: [
        sample(0, [ses(1)]), sample(1, [ses(1)]), sample(2, [ses(1)]),
        sample(3, [ses(1, { cls: 'lock', since: T0 + 40_000, blockedBy: 9 })]),
      ],
    }));
    expect(tree.tables[0]!.statements[0]!.sessions[0]!.spans).toEqual([
      { cls: 'cpu', from: T0, to: T0 + 40_000, blockedBy: null },
      { cls: 'lock', from: T0 + 40_000, to: T0 + 4 * BUCKET, blockedBy: 9 },
    ]);
  });

  it('treats a pid that reconnected as two sessions', () => {
    const tree = buildTree(input({
      samples: [0, 1, 2, 3, 4, 5].map((i) => sample(i, [ses(1, i < 3 ? {} : { backendStart: 'later', since: T0 + 3 * BUCKET })])),
    }));
    expect(tree.tables[0]!.statements[0]!.sessions.map((s) => s.backendStart).sort()).toEqual(['b1', 'later']);
  });

  it('runs a live session\'s span to the window\'s end', () => {
    const to = T0 + 2 * MIN;
    const tree = buildTree(input({
      to, columns: 8, live: true,
      samples: [sample(0, [ses(1)]), sample(4, [ses(1)]), { ...sample(0, [ses(1)]), at: to - 2000 }],
    }));
    const spans = tree.tables[0]!.statements[0]!.sessions[0]!.spans;
    expect(spans.at(-1)!.to).toBe(to);
  });

  it('lists three and counts the rest', () => {
    const five = [1, 2, 3, 4, 5].map((p) => ses(p));
    const tree = buildTree(input({ samples: [0, 1, 2].map((i) => sample(i, five)) }));
    expect(tree.tables[0]!.statements[0]!.sessions).toHaveLength(3);
    expect(tree.tables[0]!.statements[0]!.more).toBe(2);
  });

  // Review Focus 6.
  it('stops at statements past two hours, in the same order', () => {
    const cells = [
      { col: 0, kind: 't' as const, key: 'public.hot', cls: 'cpu' as const, sessions: 3 },
      { col: 0, kind: 't' as const, key: 'public.cool', cls: 'cpu' as const, sessions: 1 },
      { col: 0, kind: 'q' as const, key: 'q1', cls: 'cpu' as const, sessions: 3 },
      { col: 0, kind: 'd' as const, key: '', cls: 'cpu' as const, sessions: 4 },
    ];
    const tree = buildTree(input({
      to: T0 + 360 * MIN, columns: 120, raw: false, cells,
      statements: new Map([['q1', { text: 'SELECT 1', relations: ['public.hot'] }]]),
    }));
    expect(tree.sessionsShown).toBe(false);
    expect(tree.tables.map((t) => t.name)).toEqual(['public.hot', 'public.cool']);
    expect(tree.tables[0]!.statements.map((s) => [s.key, s.sessions.length])).toEqual([['q1', 0]]);
    expect(tree.band[0]).toEqual([4, 0, 0, 0, 0]);
  });
});

describe('findings', () => {
  // The seeded chain as it was measured: 3 waits on 2, 2 waits on 1, 1 is idle in transaction.
  const chain = (i: number) => sample(i, [
    ses(1, { cls: 'idle', since: T0 + 5 * MIN - 2000, statement: 'upd' }),
    ses(2, { cls: 'lock', since: T0 + 5 * MIN, blockedBy: 1, statement: 'del' }),
    ses(3, { cls: 'lock', since: T0 + 5 * MIN + 100, blockedBy: 2, statement: 'upd' }),
  ]);
  const calm = (i: number) => sample(i, [ses(9, { relations: ['public.orders'] })]);
  const samples = [...Array(60)].map((_, i) => (i >= 20 && i < 40 ? chain(i) : calm(i)));
  const tree = buildTree(input({ samples }));

  it('states a chain once, on its table, behind the one pid nobody blocks', () => {
    expect(tree.findings).toHaveLength(1);
    expect(tree.findings[0]).toMatchObject({
      kind: 'chain', table: 'public.users', pid: 1, backendStart: 'b1',
      since: T0 + 5 * MIN, to: T0 + 40 * BUCKET,
    });
    expect(tree.findings[0]!.waiters.map((w) => w.pid)).toEqual([2, 3]);
  });

  // Review Focus 6.
  it('has nothing to say two minutes before the chain', () => {
    expect(findingsAt(tree, T0 + 3 * MIN)).toEqual([]);
  });

  it('has the chain and its waiters one sample into it', () => {
    // At the sample itself only the first wait has begun; the second began 100 ms later.
    expect(findingsAt(tree, T0 + 20 * BUCKET)[0]).toMatchObject({ level: 'warn', waiting: 1 });
    expect(findingsAt(tree, T0 + 20 * BUCKET + 1000)[0]).toMatchObject({ level: 'warn', waiting: 2 });
  });

  it('turns critical once a wait passes a minute, and ends when the chain does', () => {
    expect(findingsAt(tree, T0 + 6 * MIN + 1000)[0]!.level).toBe('critical');
    expect(findingsAt(tree, T0 + 40 * BUCKET)).toEqual([]);
  });

  it('gives each session of the chain one row, even under three', () => {
    const rows = tree.tables.find((t) => t.name === 'public.users')!.statements.flatMap((s) => s.sessions.map((x) => x.pid));
    expect(rows.sort()).toEqual([1, 2, 3]);
  });

  it('holds a live chain open to the window\'s end', () => {
    const to = T0 + 6 * MIN;
    const live = buildTree(input({ to, columns: 24, live: true, samples: [...Array(24)].map((_, i) => (i >= 20 ? chain(i) : calm(i))) }));
    expect(live.findings[0]!.to).toBe(to);
    expect(findingsAt(live, to - 1)).toHaveLength(1);
  });

  /**
   * A poll lands mid-bucket: the store holds this bucket's sample with the
   * chain in it, and the live read, a few seconds on, has none. The older
   * one speaks only until the newer one does.
   */
  it('drops a chain the moment a newer sample in the same bucket no longer has it', () => {
    const to = T0 + 5 * MIN + 20_000;
    const stored = chain(21);                                          // 08:05:15
    const justRead: Sample = { at: to, sessions: [ses(9, { relations: ['public.orders'] })], hidden: false, truncated: false };
    const live = buildTree(input({ to, live: true, samples: [chain(20), stored, justRead] }));
    expect(live.findings[0]!.to).toBe(to);
    expect(findingsAt(live, to - 1)).toHaveLength(1);                  // the stored one, up to the read
    const next: Sample = { ...justRead, at: to + 5_000 };
    const later = buildTree(input({ to: to + 5_000, live: true, samples: [chain(20), stored, justRead, next] }));
    expect(findingsAt(later, to + 5_000 - 1)).toEqual([]);
    const rows = later.tables.find((t) => t.name === 'public.users')!.statements.flatMap((s) => s.sessions);
    expect(Math.max(...rows.flatMap((r) => r.spans.map((p) => p.to)))).toBe(to);
  });

  // Review Focus 4.
  it('ends a cycle of blockers instead of walking it for ever, as one finding', () => {
    const tree2 = buildTree(input({
      samples: [sample(0, [
        ses(1, { cls: 'lock', blockedBy: 2 }),
        ses(2, { cls: 'lock', blockedBy: 1 }),
      ])],
    }));
    expect(tree2.findings).toHaveLength(1);
    expect(tree2.findings[0]).toMatchObject({ kind: 'chain', pid: 1 });
    expect(tree2.findings[0]!.waiters.map((w) => w.pid)).toEqual([2]);
  });

  it('names a blocker the sample does not hold as the root, by pid alone', () => {
    const tree2 = buildTree(input({ samples: [sample(0, [ses(2, { cls: 'lock', blockedBy: 77 })])] }));
    expect(tree2.findings[0]).toMatchObject({ pid: 77, backendStart: null, table: 'public.users' });
  });

  it('finds a transaction idle past a minute, and leaves a chain\'s root to its chain', () => {
    const idle = (i: number) => sample(i, [ses(5, { cls: 'idle', since: T0 })]);
    const tree2 = buildTree(input({ samples: [...Array(30)].map((_, i) => idle(i)) }));
    expect(tree2.findings).toHaveLength(1);
    expect(tree2.findings[0]).toMatchObject({ kind: 'idle', pid: 5, from: T0 + MIN });
    expect(findingsAt(tree2, T0 + 30_000)).toEqual([]);
    expect(findingsAt(tree2, T0 + 6 * MIN)[0]!.level).toBe('critical');
    expect(tree.findings.every((f) => f.kind === 'chain')).toBe(true);
  });

  it('knows a chain in a wide window from its events, with no pid to act on', () => {
    const wide = buildTree(input({
      to: T0 + 360 * MIN, columns: 120, raw: false,
      events: [
        { at: T0 + 10 * MIN, kind: 'chain-begin', relation: 'public.users' },
        { at: T0 + 12 * MIN, kind: 'chain-end', relation: 'public.users' },
        { at: T0 + 300 * MIN, kind: 'chain-begin', relation: 'public.orders' },
      ],
    }));
    expect(wide.findings.map((f) => [f.table, f.pid, f.from, f.to])).toEqual([
      ['public.users', null, T0 + 10 * MIN, T0 + 12 * MIN],
      ['public.orders', null, T0 + 300 * MIN, T0 + 360 * MIN],
    ]);
  });

  it('knows a past chain from its events in a window of exactly two hours that reads the rollup', () => {
    const wide = buildTree(input({
      to: T0 + 120 * MIN, columns: 120, raw: false,
      events: [
        { at: T0 + 10 * MIN, kind: 'chain-begin', relation: 'public.users' },
        { at: T0 + 12 * MIN, kind: 'chain-end', relation: 'public.users' },
      ],
    }));
    expect(wide.findings.map((f) => [f.table, f.pid])).toEqual([['public.users', null]]);
    expect(wide.sessionsShown).toBe(false);
  });

  it('prefers the live sample to the event for the chain running now', () => {
    const to = T0 + 360 * MIN;
    const wide = buildTree(input({
      to, columns: 120, live: true, raw: false,
      events: [{ at: to - 2 * MIN, kind: 'chain-begin', relation: 'public.users' }],
      samples: [{ at: to - 1000, hidden: false, truncated: false, sessions: [
        ses(1, { cls: 'idle', since: to - 3 * MIN }),
        ses(2, { cls: 'lock', since: to - 2 * MIN, blockedBy: 1 }),
      ] }],
    }));
    expect(wide.findings).toHaveLength(1);
    expect(wide.findings[0]).toMatchObject({ pid: 1, backendStart: 'b1' });
  });
});

describe('a statement\'s sessions', () => {
  it('lists the ones still there at the window\'s end before older ones, chains or not', () => {
    // Three earlier chains' sessions, all gone, then one session running at the end.
    const old = [1, 2, 3].map((p) => ses(p, { cls: 'idle', since: T0 }));
    const samples = [
      ...[...Array(10)].map((_, i) => sample(i, [...old, ses(9, { cls: 'lock', since: T0, blockedBy: 1 })])),
      ...[...Array(4)].map((_, i) => sample(20 + i, [ses(7, { since: T0 + 20 * BUCKET - 60_000 })])),
    ];
    const q = buildTree(input({ samples })).tables[0]!.statements[0]!;
    expect(q.sessions[0]!.pid).toBe(7);
  });
});

describe('a table past the cap', () => {
  it('is listed when the URL opens it, so its own page has its rows', () => {
    const many = [...Array(TABLES_SHOWN + 5)].map((_, i) => ses(i + 1, { relations: [`public.t${String(i).padStart(3, '0')}`] }));
    const cold = `public.t${String(TABLES_SHOWN + 4).padStart(3, '0')}`;
    const tree = buildTree(input({ samples: [sample(0, many)], open: new Set([cold]) }));
    expect(tree.tables.map((t) => t.name)).toContain(cold);
    expect(tree.tables).toHaveLength(TABLES_SHOWN + 1);
    expect(tree.tablesMore).toBe(4);
  });
});

describe('what was not sampled', () => {
  it('marks the columns no sample covered, and reads a half-sampled column over its sampled half', () => {
    // Samples for the first five minutes, then nothing: the sampler stopped.
    const tree = buildTree(input({ samples: [...Array(20)].map((_, i) => sample(i, [ses(1)])) }));
    expect(tree.seen.slice(0, 20).every((k) => k === 1)).toBe(true);
    expect(tree.seen.slice(21).every((k) => k === 0)).toBe(true);
    expect(total(tree.band, 5)).toBe(1);
  });

  it('takes the store\'s word for a window that reads the rollup, and the mean over what it sampled', () => {
    const tree = buildTree(input({
      to: T0 + 360 * MIN, columns: 120, raw: false, coverage: [0.5, ...Array(119).fill(0)],
      cells: [{ col: 0, kind: 'd', key: '', cls: 'cpu', sessions: 1 }],
    }));
    expect(tree.seen[0]).toBe(0.5);
    expect(tree.seen[1]).toBe(0);
    expect(tree.band[0]).toEqual([2, 0, 0, 0, 0]);
  });

  it('counts the column a live page just read as seen', () => {
    const tree = buildTree(input({ live: true, samples: [sample(59, [])] , to: T0 + 15 * MIN }));
    expect(tree.seen.at(-1)).toBe(1);
  });
});

describe('quiet tables and the find box', () => {
  const fact = (name: string, sizeBytes: number) => ({ name, sizeBytes, liveRows: 0, flags: [] });

  // Review Focus 5.
  it('counts ten thousand quiet tables and names the largest two hundred', () => {
    const tables = [...Array(1000)].map((_, i) => fact(`public.t${i}`, i));
    const tree = buildTree(input({ tables, tablesTotal: 10_000, open: new Set([FOLD_QUIET]) }));
    expect(tree.tables).toEqual([]);
    expect(tree.quiet).toHaveLength(QUIET_SHOWN);
    expect(tree.quiet[0]!.name).toBe('public.t999');
    expect(tree.quietTotal).toBe(10_000);
    expect(tree.empty).toBe(false);
  });

  it('says a database with no tables and no sessions is empty, and one whose catalog could not be read is not', () => {
    expect(buildTree(input()).empty).toBe(true);
    expect(buildTree(input({ tablesTotal: null })).empty).toBe(false);
  });

  it('does not count a hot table as quiet', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1)])], tables: [fact('public.users', 9), fact('public.audit', 5)], tablesTotal: 2, open: new Set([FOLD_QUIET]) }));
    expect(tree.quiet.map((t) => t.name)).toEqual(['public.audit']);
    expect(tree.quietTotal).toBe(1);
  });

  const found = (find: string) => buildTree(input({
    find,
    samples: [0, 1, 2].map((i) => sample(i, [ses(8168, { statement: 'upd' }), ses(2, { statement: 'sel', relations: ['public.orders'] })])),
    statements: texts({ upd: 'UPDATE users SET plan = $1', sel: 'SELECT * FROM orders' }),
    tables: [fact('public.audit_log', 5), fact('public.settings', 1)], tablesTotal: 2,
  }));

  it('narrows to a table by name, keeping all of its statements', () => {
    expect(found('USERS').tables.map((t) => [t.name, t.statements.length])).toEqual([['public.users', 1]]);
  });
  it('narrows to a statement by its text', () => {
    expect(found('from orders').tables.map((t) => t.name)).toEqual(['public.orders']);
  });
  it('narrows to a session by its pid', () => {
    expect(found('8168').tables.map((t) => t.statements.map((s) => s.key))).toEqual([['upd']]);
  });
  it('reaches a quiet table', () => {
    const tree = found('audit');
    expect(tree.tables).toEqual([]);
    expect(tree.quiet.map((t) => t.name)).toEqual(['public.audit_log']);
    expect(tree.quietTotal).toBe(1);
  });
});

describe('what the sample could not see', () => {
  it('carries the restricted role and the cut from the newest sample', () => {
    const tree = buildTree(input({ samples: [sample(0, []), sample(1, [], { hidden: true, truncated: true })] }));
    expect(tree).toMatchObject({ hidden: true, truncated: true });
  });
});

describe('shapes nobody is running', () => {
  const shape = (key: string, relations: string[] | null, over: Partial<Shape> = {}): Shape =>
    ({ key, text: `SELECT ${key}`, relations, callsPerSec: 2, meanMs: 5, ...over });
  const open = (...names: string[]) => new Set(names);

  it('sits under the table its plan names, with its numbers and no load', () => {
    const tree = buildTree(input({ shapes: [shape('7', ['public.orders'])], open: open('public.orders') }));
    expect(tree.tables.map((t) => t.name)).toEqual(['public.orders']);
    const [s] = tree.tables[0]!.statements;
    expect(s).toMatchObject({ key: '7', text: 'SELECT 7', unplaced: false, callsPerSec: 2, meanMs: 5 });
    expect(s!.strip.every((c) => c.every((v) => v === 0))).toBe(true);
  });

  // Review Focus 1.
  it('sits under "not on any table", marked, when no plan says where', () => {
    const tree = buildTree(input({ shapes: [shape('8', null, { text: 'BEGIN' })], open: open(FOLD_NONE) }));
    expect(tree.tables).toEqual([]);
    expect(tree.none!.statements.map((s) => [s.text, s.unplaced])).toEqual([['BEGIN', true]]);
  });

  it('is on no table and not "not placed" when its plan found none', () => {
    const tree = buildTree(input({ shapes: [shape('9', [])], open: open(FOLD_NONE) }));
    expect(tree.none!.statements[0]).toMatchObject({ key: '9', unplaced: false });
  });

  // Review Focus 1: its locks already said where it is.
  it('stays where its locks put it while its plan is unknown', () => {
    const tree = buildTree(input({
      samples: [sample(0, [ses(1, { statement: '7' })])], shapes: [shape('7', null)], open: open('public.users'),
    }));
    expect(tree.none).toBeNull();
    expect(tree.tables[0]!.statements[0]).toMatchObject({ key: '7', unplaced: false, callsPerSec: 2 });
  });

  it('is listed under each table its plan names', () => {
    const tree = buildTree(input({ shapes: [shape('7', ['public.a', 'public.b'])], open: open('public.a', 'public.b') }));
    expect(tree.tables.map((t) => [t.name, t.statements[0]!.tables])).toEqual([
      ['public.a', ['public.a', 'public.b']], ['public.b', ['public.a', 'public.b']],
    ]);
  });

  it('lists a table with statements and no load after every table with load, the costliest first', () => {
    const tree = buildTree(input({
      samples: [sample(0, [ses(1)])],
      shapes: [shape('7', ['public.cheap'], { callsPerSec: 1, meanMs: 1 }), shape('8', ['public.dear'], { callsPerSec: 10, meanMs: 50 })],
    }));
    expect(tree.tables.map((t) => t.name)).toEqual(['public.users', 'public.dear', 'public.cheap']);
  });

  it('is found by its text', () => {
    const tree = buildTree(input({ shapes: [shape('7', ['public.orders'], { text: 'SELECT total FROM orders' })], find: 'total' }));
    expect(tree.tables[0]!.statements.map((s) => s.key)).toEqual(['7']);
  });
});

describe('the flat list', () => {
  const two = [sample(0, [ses(1), ses(2), ses(3, { statement: 'q2', relations: ['public.orders'] })])];

  it('is empty on the tree, which does not ask for it', () => {
    expect(buildTree(input({ samples: two }))).toMatchObject({ flat: [], flatMore: 0 });
  });

  it('lists the hottest statements whatever table they are on, and counts the rest', () => {
    const tree = buildTree(input({ samples: two, flat: 1, open: new Set() }));
    expect(tree.flat.map((s) => [s.key, s.tables])).toEqual([['q1', ['public.users']]]);
    expect(tree.flatMore).toBe(1);
  });

  it('includes a statement nobody is running, after the ones that are', () => {
    const tree = buildTree(input({
      samples: two, flat: 10,
      shapes: [{ key: '7', text: 'SELECT 7', relations: ['public.audit'], callsPerSec: 9, meanMs: 9 }],
    }));
    expect(tree.flat.map((s) => s.key)).toEqual(['q1', 'q2', '7']);
  });

  it('is narrowed by a find, as the tree is', () => {
    const tree = buildTree(input({ samples: two, flat: 10, statements: texts({ q1: 'UPDATE users', q2: 'INSERT INTO orders' }), find: 'orders' }));
    expect(tree.flat.map((s) => s.key)).toEqual(['q2']);
  });

  it('lists one statement alone, with every lasting session it has', () => {
    const many = [...Array(6)].map((_, i) => ses(10 + i, { since: T0 - 120_000 }));
    const tree = buildTree(input({ samples: [sample(0, many), sample(1, many), sample(2, many)], only: 'q1', sessionsMax: 200 }));
    expect(tree.flat).toHaveLength(1);
    expect(tree.flat[0]!.sessions).toHaveLength(6);
    expect(tree.flat[0]!.more).toBe(0);
    expect(buildTree(input({ samples: two, only: 'nope' })).flat).toEqual([]);
  });
});

describe('the server\'s findings, from the health row', () => {
  const minute = (i: number, over: Partial<HealthMinute> = {}): HealthMinute => ({
    at: T0 + i * MIN, connections: 5, serverConnections: 20, maxConnections: 100, lagSecs: 0, lagBytes: 0, walBytes: null,
    xidAge: 1000, xminAge: null, deadlocks: 0, commits: null, rollbacks: null, statsReset: T0 - MIN, ...over,
  });
  const at = (tree: Tree, i: number) => findingsAt(tree, T0 + i * MIN + 1000);

  it('names connections near the limit while they stay there, with the worst minute as the figure', () => {
    const health = [minute(0), minute(1, { serverConnections: 85 }), minute(2, { serverConnections: 88 }), minute(3, { serverConnections: 86 }), minute(4)];
    const tree = buildTree(input({ health }));
    expect(tree.findings).toHaveLength(1);
    expect(tree.findings[0]).toMatchObject({ kind: 'connections', level: 'warn', note: '88 of 100', from: T0 + MIN, to: T0 + 4 * MIN });
    expect(at(tree, 0)).toEqual([]);
    expect(at(tree, 2)[0]).toMatchObject({ level: 'warn', waiting: 0 });
    expect(at(tree, 4)).toEqual([]);
  });

  it('is two findings when the level changes, and holds the last minute for two and a half', () => {
    const health = [minute(0, { serverConnections: 85 }), minute(1, { serverConnections: 95 })];
    const tree = buildTree(input({ health }));
    expect(tree.findings.map((f) => [f.kind, f.level, f.from, f.to])).toEqual([
      ['connections', 'warn', T0, T0 + MIN], ['connections', 'critical', T0 + MIN, T0 + MIN + 150_000],
    ]);
    expect(findingsAt(tree, T0 + MIN + 149_000)).toHaveLength(1);
    expect(findingsAt(tree, T0 + MIN + 151_000)).toEqual([]);
  });

  it('judges replication by the standby marks and transaction ID age by what is left, naming the figures', () => {
    const tree = buildTree(input({ health: [minute(0, { lagSecs: 45, lagBytes: 2_000_000 }), minute(1, { xidAge: 2_147_483_647 - 90_000_000, lagSecs: 400, lagBytes: null })] }));
    expect(at(tree, 0).map((r) => [r.finding.kind, r.level, r.finding.note])).toEqual([['replication', 'warn', '45s · 1.9 MB']]);
    expect(at(tree, 1).map((r) => [r.finding.kind, r.level, r.finding.note])).toEqual([
      ['replication', 'critical', '6m 40s'], ['xid', 'critical', '2.1B transactions old'],
    ]);
  });

  it('says a deadlock once, for the minute it happened in, and not when the counter fell with a reset', () => {
    const tree = buildTree(input({ health: [minute(0, { deadlocks: 2 }), minute(1, { deadlocks: 4 }), minute(2, { deadlocks: 4 }), minute(3, { deadlocks: 1, statsReset: T0 + 2 * MIN })] }));
    expect(tree.findings).toHaveLength(1);
    expect(tree.findings[0]).toMatchObject({ kind: 'deadlock', level: 'warn', note: '2 deadlocks', from: T0, to: T0 + MIN });
    expect(at(tree, 0)).toHaveLength(1);
    expect(at(tree, 1)).toEqual([]);
    expect(at(tree, 3)).toEqual([]);
  });

  it('extends a stretch the store began with the live minute, and ranks it with a chain', () => {
    const live = buildTree(input({
      live: true, raw: true, to: T0 + 15 * MIN, samples: [sample(59, [ses(1, { cls: 'idle', since: T0 })])],
      health: [minute(13, { serverConnections: 85 }), minute(14, { serverConnections: 85 }), { ...minute(15), at: T0 + 15 * MIN - 1, serverConnections: 88 }],
    }));
    const found = findingsAt(live, T0 + 15 * MIN - 1);
    expect(found.map((r) => [r.finding.kind, r.level])).toEqual([['idle', 'critical'], ['connections', 'warn']]);
    expect(live.findings.find((f) => f.kind === 'connections')).toMatchObject({ from: T0 + 13 * MIN, to: T0 + 15 * MIN, note: '88 of 100' });
  });

  it('says nothing of a minute it could not read, and opens the hottest table rather than a server finding\'s', () => {
    const tree = buildTree(input({ samples: [sample(0, [ses(1)])], health: [minute(0, { serverConnections: null, lagSecs: null, xidAge: null }), minute(1, { serverConnections: 99 })] }));
    expect(tree.findings.map((f) => f.kind)).toEqual(['connections']);
    expect(tree.tables[0]!.open).toBe(true);
  });
});
