import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Overview from '@/app/page';

// See kill-button.test.tsx: vitest gives each test FILE its own JS realm, so
// this flag is a per-file requirement rather than a one-time one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Read by the hoisted mock factory below, so each test can choose what the
// twelve incident checks answer without re-mocking the module.
const state = vi.hoisted(() => ({
  mode: 'healthy' as 'healthy' | 'unreachable' | 'warn' | 'facts' | 'facts-chained' | 'facts-blind',
  // The cached hygiene read behind the quiet column. `ok: false` is the
  // no-store default, which is what every other test in this file assumes.
  hygiene: { ok: false, message: 'History is off.' } as unknown,
}));

// The overview reaches configuration directly rather than through a check, so
// it awaits `connection()` itself — see the long comment on the page. Faked
// here because there is no Next request store in a unit test.
vi.mock('next/server', () => ({ connection: async () => {} }));
// <Refresh> calls useRouter() on its render path and there is no app router
// mounted in a unit test — the same shim every other page test uses.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/pools', () => ({ databaseNames: () => ['prod'] }));

vi.mock('@/lib/hygiene', () => ({ hygieneFor: vi.fn(async () => state.hygiene) }));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    /**
     * A6. The three `facts` modes differ in ONE thing — whether the lock
     * graph names the long-running pid, and whether it could be read at all
     * — because that is what decides whether "longest query" is a second
     * telling of "2 blocked" or a separate finding.
     */
    if (state.mode === 'facts' || state.mode === 'facts-chained' || state.mode === 'facts-blind') {
      const data: Record<string, unknown> = {
        connections: { used: 14, max: 100, reserved: 3, headroom: 83 },
        blocked: { count: 2, longestQueryAgeSecs: 46, longestWaitSecs: 46, suspectPid: 9401 },
        longRunning: { queries: [{ pid: 9403, runningSecs: 195, query: 'x', backendStart: null }], truncated: false },
        replicationLag: { inRecovery: true, lagSeconds: 4, standbys: 0, receiving: true },
        standbys: { standbys: [] },
      };
      if (check.id === 'locks') {
        if (state.mode === 'facts-blind') {
          return { ok: false, reason: 'privilege', message: 'permission denied for table pg_locks' };
        }
        // `facts-chained` puts the long-running pid INSIDE the chain;
        // `facts` leaves the chain empty so that pid is genuinely slow.
        const roots = state.mode === 'facts-chained'
          ? [{
              pid: 9401, user: null, app: null, query: null, state: 'idle in transaction',
              backendStart: null, waitingMode: null, waitingOn: null, xactAgeSecs: 300,
              waitSecs: null, totalWaiters: 1,
              waiters: [{
                pid: 9403, user: null, app: null, query: null, state: 'active', backendStart: null,
                waitingMode: null, waitingOn: null, xactAgeSecs: 195, waitSecs: 195,
                cycle: false, waiters: [],
              }],
            }]
          : [];
        return { ok: true, data: { roots, truncated: false }, verdict: { level: 'ok' }, measuredAt: 0 };
      }
      return { ok: true, data: data[check.id] ?? {}, verdict: { level: 'ok' }, measuredAt: 0 };
    }
    if (state.mode === 'unreachable') {
      // What EVERY check returns when the host is not there. `runCheck` never
      // rejects, so a database that does not exist is twelve of these — not
      // an exception, not a partial result.
      return { ok: false, reason: 'error', message: 'database "nope" does not exist' };
    }
    /**
     * `data: {}` for every check is this mock's long-standing shortcut, and
     * A6 is where it stopped being free: the page now READS fields off
     * results rather than only their verdicts, so a result missing the
     * shape its check promises is a crash rather than a blank. Only the
     * fields the page reads are filled in — enough to be honest, not a
     * second copy of every check's data shape.
     *
     * This is the hazard the repo already knows about: a page suite mocks
     * `runCheckFor`, so the MOCK is the shape, and a page reading a field no
     * check returns passes every page test.
     */
    const shape: Record<string, unknown> = {
      locks: { roots: [], truncated: false },
      connections: { used: 1, max: 100, reserved: 3, headroom: 96 },
      blocked: { count: 0, longestQueryAgeSecs: null, longestWaitSecs: null, suspectPid: null },
      longRunning: { queries: [], truncated: false },
      replicationLag: { inRecovery: false, lagSeconds: null, standbys: 0, receiving: null },
      standbys: { standbys: [] },
    };
    const data = shape[check.id] ?? {};
    if (state.mode === 'warn') {
      return { ok: true, data, verdict: { level: 'warn', note: 'getting full' }, measuredAt: 0 };
    }
    return { ok: true, data, verdict: { level: 'ok' }, measuredAt: 0 };
  }),
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  state.mode = 'healthy';
  state.hygiene = { ok: false, message: 'History is off.' };
});

describe('Overview — a verdict is earned, never assumed', () => {
  /**
   * The defect this file exists for, found by pointing the console at a
   * database that does not exist and reading the front door.
   *
   * `worstVerdict` seeded `worst = {level: 'ok'}` and only ever moved it
   * downward as checks reported. A database where every check FAILED reported
   * nothing at all, so the seed survived and the row rendered a positive OK
   * badge — directly beside its own "12 checks unavailable". The spec's rule
   * is that "we could not look" and "we looked and it's fine" must never
   * render the same, and this was the front door rendering exactly that, on
   * the page whose entire job is answering "is anything wrong anywhere?".
   *
   * Every existing test covered a database that ANSWERED. None covered one
   * that could not be reached, which is the only way to reach the seed.
   */
  it('links to the fleet health page', async () => {
    state.mode = 'healthy';
    rendered = await render(await Overview());
    expect(rendered.container.querySelector('a[href="/health"]')).not.toBeNull();
  });

  it('does not claim OK for a database where every check failed', async () => {
    state.mode = 'unreachable';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).not.toContain('OK');
    expect(text).toContain('UNKNOWN');
    // The count of failed checks is reported, and it must not be reported as
    // if it were a clean bill of health.
    expect(text).toContain('unavailable');
    expect(text).toContain('could not be assessed');
  });

  it('reports OK only when a check actually returned one', async () => {
    state.mode = 'healthy';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).toContain('OK');
    expect(text).not.toContain('UNKNOWN');
    expect(text).toContain('none need attention');
  });

  /**
   * The middle level has to be distinguishable from both neighbours in TEXT,
   * not only in colour — the badge is read by screen readers, by anyone
   * colour-blind, and in grayscale screenshots.
   */
  it('names a warning as its own level and counts it as needing attention', async () => {
    state.mode = 'warn';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).toContain('WARN');
    // The verb agrees with the COUNT that needs attention, not with the
    // total: "1 of 1 database needs attention", which is what the front page
    // of this console says when one database is configured and unwell.
    expect(text).toContain('1 of 1 database needs attention');
    expect(text).not.toContain('none need attention');
  });
});

/**
 * Hygiene on the front door, which is what pgHero's dashboard does and this
 * page did not — but never in the ink of an incident.
 *
 * The overview's question is "is anything wrong RIGHT NOW". A duplicate index
 * is not an answer to it, and a row coloured by one would be lying to the
 * person who opened this page because their pager went off.
 */
describe('the quiet hygiene column', () => {
  const found = (areas: unknown[]) => ({ ok: true, areas });

  it('shows what the last capture found, with its age', async () => {
    state.hygiene = found([
      { id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
        level: 'warn', note: '2 unused indexes', ageMs: 240_000 },
      { id: 'tables', label: 'Tables', href: 'queries/tables', band: 'work',
        level: 'ok', note: null, ageMs: 240_000 },
    ]);
    rendered = await render(await Overview());
    const text = rendered.text();
    expect(text).toContain('2 unused indexes');
    // A cached reading with no age claims to be current.
    expect(text).toMatch(/4m 0s ago/);
  });

  /**
   * The row still reads OK, and that is the whole point: nothing is wrong
   * right now. Hygiene never reaches `worstVerdict`.
   */
  it('does not let a hygiene finding change the verdict', async () => {
    state.hygiene = found([
      { id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
        level: 'critical', note: '1 invalid index', ageMs: 60_000 },
    ]);
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('1 invalid index');
    expect(rendered.text()).toContain('OK');
    expect(rendered.text()).not.toContain('CRITICAL');
    expect(rendered.text()).toContain('none need attention');
  });

  it('says nothing at all when every area is healthy', async () => {
    state.hygiene = found([
      { id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
        level: 'ok', note: null, ageMs: 60_000 },
    ]);
    rendered = await render(await Overview());
    expect(rendered.text()).not.toMatch(/ago/);
  });

  /**
   * And nothing when there is no store — the column is absent rather than
   * empty, the same rule the Queries page applies to its since-last-capture
   * column.
   */
  it('says nothing when there is no history to report', async () => {
    rendered = await render(await Overview());
    expect(rendered.text()).not.toContain('History is off');
  });
});

/**
 * A6. `worstVerdict` ran twelve checks per database and threw every number
 * away, so a wall display showed "OK" and nothing a DBA could watch move.
 */
describe('Overview — the readings behind the verdict', () => {
  it('states the readings, not only the badge', async () => {
    state.mode = 'facts';
    rendered = await render(await Overview());
    const t = rendered.text();
    expect(t).toContain('14 of 100 connections');
    expect(t).toContain('2 blocked');
    expect(t).toContain('standby 4s behind');
  });

  /**
   * EDITED at the Stage 3 re-plan, before it was built. As first specified
   * this line read "2 blocked · longest query 3m 15s" for a lock chain,
   * which is the chain stated twice: the longest query IS one of the
   * waiters. That is exactly the echo A17 removed from the triage page,
   * re-introduced one level up and across twenty rows.
   */
  it('does not report the chain twice by calling a waiter the longest query', async () => {
    state.mode = 'facts-chained';
    rendered = await render(await Overview());
    const t = rendered.text();
    expect(t).toContain('2 blocked');
    expect(t).not.toContain('longest query');
  });

  it('still reports a genuinely slow query that no chain explains', async () => {
    state.mode = 'facts';
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('longest query 3m 15s');
  });

  /**
   * And the suppression never fires on a reading the console could not
   * take: with the lock graph unreadable there is no chain to attribute the
   * query to, so hiding it would hide a real finding on the strength of
   * nothing. Same rule as A17's fold.
   */
  it('reports the longest query when the lock graph could not be read', async () => {
    state.mode = 'facts-blind';
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('longest query 3m 15s');
  });

  /**
   * A quiet fleet stays quiet. Twenty rows each carrying "0 blocked · no
   * standbys" is the scannability this line would otherwise cost, so only
   * the connection count — which is always a fact — shows unconditionally.
   */
  it('shows only the connection count on a healthy database', async () => {
    state.mode = 'facts';
    rendered = await render(await Overview());
    const t = rendered.text();
    expect(t).not.toContain('0 blocked');
  });
});

/**
 * A7, the last surface. The quiet column filtered on `level !== 'ok'`, so a
 * count written by a check that judges nothing never appeared anywhere: the
 * area is OK, because a duplicate index is not a reason to call a database
 * unwell, and that is exactly why it needs to be shown as a note instead of
 * escalated into one.
 */
describe('the quiet hygiene column — counts from areas that are OK', () => {
  it('shows what an OK area found', async () => {
    state.hygiene = { ok: true, areas: [{
      id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
      level: 'ok', note: '1 duplicate index', ageMs: 60_000,
    }] };
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('1 duplicate index');
  });

  it('still says nothing when an OK area found nothing', async () => {
    state.hygiene = { ok: true, areas: [{
      id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
      level: 'ok', note: null, ageMs: 60_000,
    }] };
    rendered = await render(await Overview());
    expect(rendered.text()).not.toContain('Indexes');
  });

  /**
   * And a count must not tint the row. A database with a hygiene finding and
   * no incident still reads OK, because it IS OK — nothing is wrong right
   * now. That rule is why these are notes rather than verdicts.
   */
  it('does not let a count change the verdict', async () => {
    state.hygiene = { ok: true, areas: [{
      id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
      level: 'ok', note: '9 duplicate indexes', ageMs: 60_000,
    }] };
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('OK');
    expect(rendered.text()).not.toContain('WARN');
  });
});
/**
 * Stage 4's re-plan, from the overview as it actually rendered. With the
 * capture scheduler behind, every row read:
 *
 *   28 of 100 connections · 4 blocked
 *   last captured too long ago · last captured too long ago · last captured too long ago · 21m 51s ago
 *
 * Three areas, three identical sentences, joined. The notes carry no area
 * label, so repeating one says nothing the first did not — and this is the
 * front door, the one surface whose whole job is to be scannable across
 * twenty rows.
 *
 * `×N` rather than dropping the repeats silently: three stale areas is a
 * bigger gap in what the console knows than one, and the multiplier is the
 * idiom the Active now panel already uses for a repeated reading.
 */
describe('the quiet hygiene column — a repeated note is stated once', () => {
  const stale = (id: string, label: string) => ({
    id, label, href: `cleanup/${id}`, band: 'keep-up',
    level: 'unknown', note: 'last captured too long ago', ageMs: 1_311_000,
  });

  it('collapses areas that found the same thing, and counts them', async () => {
    state.hygiene = { ok: true, areas: [stale('space', 'Space'), stale('maintenance', 'Maintenance'), stale('sequences', 'Sequences')] };
    rendered = await render(await Overview());
    const text = rendered.text();
    expect(text).toContain('last captured too long ago ×3');
    // The defect itself: the sentence must appear once, not three times.
    expect(text.match(/last captured too long ago/g)).toHaveLength(1);
    // The age still travels with it — a cached reading with none claims to
    // be current.
    expect(text).toMatch(/21m 51s ago/);
  });

  it('adds no multiplier to a note that occurred once', async () => {
    state.hygiene = { ok: true, areas: [stale('space', 'Space')] };
    rendered = await render(await Overview());
    const text = rendered.text();
    expect(text).toContain('last captured too long ago');
    expect(text).not.toContain('×1');
  });

  it('keeps distinct findings distinct', async () => {
    state.hygiene = { ok: true, areas: [
      { id: 'indexes', label: 'Indexes', href: 'queries/indexes', band: 'work',
        level: 'warn', note: '2 unused indexes', ageMs: 60_000 },
      { id: 'tables', label: 'Tables', href: 'queries/tables', band: 'work',
        level: 'ok', note: '1 duplicate index', ageMs: 60_000 },
    ] };
    rendered = await render(await Overview());
    const text = rendered.text();
    expect(text).toContain('2 unused indexes');
    expect(text).toContain('1 duplicate index');
    expect(text).not.toContain('×');
  });
});
