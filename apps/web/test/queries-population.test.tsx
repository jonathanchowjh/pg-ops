import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import Page from '@/app/db/[name]/queries/page';
import { forget } from '@/lib/samples';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
// The real clockFor and windowFor, on the memory path.
vi.mock('@/lib/pools', async (orig) => ({ ...(await orig<typeof import('@/lib/pools')>()), storePool: () => null }));
const ran = vi.hoisted(() => ({ ids: [] as string[] }));
const state = vi.hoisted(() => ({
  sessions: [] as unknown[],
  shapes: { shapes: [] as unknown[], allMs: null as number | null },
  live: null as unknown,
}));
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_n: string, check: { id: string }) => {
    ran.ids.push(check.id);
    if (check.id === 'sessions') return { ok: true, verdict: null, measuredAt: 0, data: { sessions: state.sessions, truncated: false, hidden: 0 } };
    return state.live;
  }),
}));
vi.mock('@/lib/shapes', () => ({ shapesFor: async () => state.shapes }));

/** As tree-page.test.tsx has it: one session of the fused read. */
const session = (pid: number, over = {}) => ({
  pid, backendStart: `b${pid}`, user: 'app', app: 'web', clientAddr: null, state: 'active', cls: 'cpu', own: false,
  queryId: '42', query: "UPDATE users SET token = 'hunter2' WHERE id = 1", inStateSecs: 90, queryAgeSecs: 90, xactAgeSecs: 90,
  blockedBy: [], relations: ['public.users'], wanted: null, waitSecs: null, ...over,
});
beforeEach(() => {
  forget();
  Object.assign(state, { sessions: [], shapes: { shapes: [], allMs: null }, live: live([]) });
  ran.ids = [];
  vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
});

const shape = (key: string, text: string, callsPerSec: number, meanMs: number) => ({
  key, text, relations: ['public.users'], callsPerSec, meanMs, calls: callsPerSec * 600, totalMs: callsPerSec * 600 * meanMs, rowsPerCall: 1, cacheHit: 1,
});
const liveRow = (queryid: string, text: string, calls: number, meanMs: number) => ({
  queryid, query: text, calls, totalMs: calls * meanMs, meanMs, stddevMs: 0, rows: calls, cacheHitPct: 100, redacted: false,
});
const live = (rows: unknown[], statsResetAt: string | null = '2026-10-12T00:00:00Z') => ({
  ok: true, verdict: null, measuredAt: 0,
  data: { rows, totalShapes: 135, ownShapes: 0, sort: 'total', statsResetAt, allMs: 1_000_000 },
});

let view: Rendered;
const mount = async (sp: Record<string, string> = {}) => {
  view = await render(await Page({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve(sp) }));
};
afterEach(() => { view.unmount(); vi.unstubAllEnvs(); });

describe('/queries', () => {
  it('reads the sessions and the statement statistics, and nothing else', async () => {
    await mount();
    expect(ran.ids).toEqual(['sessions', 'queryStats']);
    expect(view.text()).toContain('135 shapes');
    expect(view.container.querySelector('a[href="/db/prod/explain"]')!.textContent).toBe('Explain a statement');
  });

  it('plots each statement of the window by calls against mean, a slow and busy one flagged, each a link to its page', async () => {
    state.shapes = { shapes: [shape('7', 'SELECT * FROM orders', 2, 40), shape('8', 'SELECT 1', 900, 0.1)], allMs: 100_000 };
    await mount();
    const dots = [...view.container.querySelectorAll('[data-dot]')];
    expect(dots.map((d) => d.getAttribute('href')).sort()).toEqual(['/db/prod/queries/7', '/db/prod/queries/8']);
    expect(dots.filter((d) => d.className.includes('bg-warning-ink'))).toHaveLength(1);
    expect(view.text()).toContain('calls a second');
  });

  it('never hands the browser a statement it has not redacted: not in a row, a label or a readout', async () => {
    state.sessions = [session(1)];
    state.shapes = { shapes: [shape('42', "UPDATE users SET token = 'hunter2' WHERE id = 1", 2, 40)], allMs: 1 };
    state.live = live([liveRow('43', "ALTER USER app PASSWORD 'hunter2'", 500, 30)]);
    await mount();
    expect(view.text()).toContain('UPDATE users SET token');
    expect(view.container.innerHTML).not.toContain('hunter2');
  });

  // Review Focus 6.
  it('plots the statistics since their reset, and says so, when the store holds no window', async () => {
    state.live = live([liveRow('7', 'SELECT * FROM orders', 86_400, 5)]);
    await mount();
    expect(view.container.querySelectorAll('[data-dot]')).toHaveLength(1);
    expect(view.text()).toContain('since the statistics were reset');
  });

  it('lists the hottest statements, and the rest behind one fold', async () => {
    state.sessions = [...Array(25)].map((_, i) => session(100 + i, { queryId: String(i), query: `SELECT ${i}` }));
    await mount();
    expect(view.container.querySelectorAll('[role=row][aria-level="1"]')).toHaveLength(21);
    const more = view.container.querySelector('a[href*="open=rest"]')!;
    expect(more.textContent).toBe('+ 5 more statements');
  });

  it('says the statistics could not be read instead of drawing an empty plot', async () => {
    state.live = { ok: false, reason: 'missing-extension', message: 'relation "pg_stat_statements" does not exist', remedy: 'CREATE EXTENSION pg_stat_statements;' };
    await mount();
    expect(view.text()).toContain('pg_stat_statements');
  });
});
