import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Overview from '@/app/page';

// Per-file requirement — see actions.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Read by the hoisted mock factories below, so each test chooses what the checks answer.
const state = vi.hoisted(() => ({
  mode: 'healthy' as 'healthy' | 'unreachable' | 'warn' | 'facts' | 'facts-chained' | 'facts-blind',
}));

// The overview awaits `connection()` itself; there is no Next request store in a unit test.
vi.mock('next/server', () => ({ connection: async () => {} }));
// <Refresh> calls useRouter() on its render path and no app router is mounted here.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/pools', () => ({ databaseNames: () => ['prod'] }));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    /**
     * The three `facts` modes differ only in whether the lock graph names the
     * long-running pid, and whether it could be read at all: that decides
     * whether "longest query" repeats "2 blocked" or is a separate finding.
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
        // `facts-chained` puts the long-running pid inside the chain;
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
      // `runCheck` never rejects, so an unreachable database is this from every check.
      return { ok: false, reason: 'error', message: 'database "nope" does not exist' };
    }
    /**
     * The page reads fields off results, not only their verdicts, so a result
     * missing its check's shape would crash. Only the fields the page reads
     * are filled in. Hazard: the mock is the shape, so a page reading a field
     * no check returns passes every page test.
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
});

describe('Overview — a verdict is earned, never assumed', () => {
  it('links to the fleet health page', async () => {
    state.mode = 'healthy';
    rendered = await render(await Overview());
    expect(rendered.container.querySelector('a[href="/health"]')).not.toBeNull();
  });

  /**
   * "We could not look" and "we looked and it's fine" must never render the
   * same. A `worstVerdict` seeded with OK would survive a database where
   * every check failed and render an OK badge.
   */
  it('does not claim OK for a database where every check failed', async () => {
    state.mode = 'unreachable';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).not.toContain('OK');
    expect(text).toContain('UNKNOWN');
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
   * The middle level must be distinguishable in text, not only in colour:
   * screen readers, colour-blind readers, grayscale screenshots.
   */
  it('names a warning as its own level and counts it as needing attention', async () => {
    state.mode = 'warn';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).toContain('WARN');
    // The verb agrees with the count that needs attention, not with the total.
    expect(text).toContain('1 of 1 database needs attention');
    expect(text).not.toContain('none need attention');
  });

  it('reads no cache: a row is its verdict and its incident facts', async () => {
    state.mode = 'healthy';
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('1 of 100 connections');
    expect(rendered.text()).not.toMatch(/unused|not assessed|never captured/);
  });
});

/** Each row states the numbers its checks read, not only the badge. */
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
   * "2 blocked · longest query 3m 15s" for a lock chain states the chain
   * twice: the longest query is one of the waiters.
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
   * With the lock graph unreadable there is no chain to attribute the query
   * to, so the suppression must not fire.
   */
  it('reports the longest query when the lock graph could not be read', async () => {
    state.mode = 'facts-blind';
    rendered = await render(await Overview());
    expect(rendered.text()).toContain('longest query 3m 15s');
  });

  /** Only the connection count shows unconditionally; zero readings are not printed. */
  it('shows only the connection count on a healthy database', async () => {
    state.mode = 'facts';
    rendered = await render(await Overview());
    const t = rendered.text();
    expect(t).not.toContain('0 blocked');
  });
});

