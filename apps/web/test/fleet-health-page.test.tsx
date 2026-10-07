import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_METRICS, type HealthHistory, type HealthPoint } from '@pgops/checks';
import { render, type Rendered } from './render.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ read: null as unknown, names: ['prod', 'quiet'] }));

vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/pools', () => ({ databaseNames: () => state.names }));
vi.mock('@/lib/health', async (original) => ({
  ...(await original<typeof import('@/lib/health')>()),
  healthFor: vi.fn(async () => state.read),
}));

import FleetHealth from '@/app/health/page';
import { COLLECTING, HISTORY_OFF } from '@/lib/health';

const point = (at: number, over: Partial<HealthPoint>): HealthPoint => ({
  at, ...Object.fromEntries(HEALTH_METRICS.map((m) => [m, null])), ...over,
} as HealthPoint);

const history = (
  name: string, rows: number, over: Partial<HealthPoint>, lastAt: number | null = rows === 0 ? null : Date.now(),
): HealthHistory => ({
  name, rows, lastAt, points: [0, 1, 2, 3].map((i) => point(i * 120_000, rows === 0 ? {} : over)),
});

let view: Rendered | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

describe('/health', () => {
  it('says history is off, and how to turn it on, when there is no store', async () => {
    state.read = { ok: false, kind: 'off', message: HISTORY_OFF };
    view = await render(await FleetHealth());
    expect(view.text()).toContain('PGOPS_STORE_URL');
    expect(view.container.querySelectorAll('figure')).toHaveLength(0);
  });

  it('draws six charts for a database with history', async () => {
    state.read = {
      ok: true,
      histories: [history('prod', 40, {
        serverConnections: 30, connections: 9, maxConnections: 97, blocked: 0, avgActive: 0.4,
        hitPct: 99.2, replicationLagSecs: 1, xidAge: 5_000_000,
      })],
    };
    state.names = ['prod'];
    view = await render(await FleetHealth());
    expect(view.container.querySelectorAll('figure')).toHaveLength(6);
    expect(view.container.querySelectorAll('svg')).toHaveLength(6);
    expect(view.container.querySelector('a[href="/db/prod/health"]')).not.toBeNull();
  });

  /** Review Focus 3. */
  it('says a database with no rows is collecting, beside one that draws', async () => {
    state.names = ['prod', 'quiet'];
    state.read = {
      ok: true,
      histories: [
        history('prod', 40, { serverConnections: 30, blocked: 0 }),
        history('quiet', 0, {}),
      ],
    };
    view = await render(await FleetHealth());
    const sections = [...view.container.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections[0]!.querySelectorAll('figure').length).toBe(6);
    expect(sections[1]!.textContent).toContain(COLLECTING);
    expect(sections[1]!.querySelectorAll('figure')).toHaveLength(0);
  });

  it('gives the reason, not a flat line, for a figure that was never readable', async () => {
    state.names = ['prod'];
    state.read = { ok: true, histories: [history('prod', 40, { serverConnections: 30, blocked: 0 })] };
    view = await render(await FleetHealth());
    expect(view.text()).toContain('No standby reported a replay lag');
    expect(view.container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('shows a store that could not be read as an error', async () => {
    state.read = { ok: false, kind: 'error', message: 'relation "pgops.health_stats" does not exist' };
    view = await render(await FleetHealth());
    expect(view.container.querySelector('[role="alert"]')!.textContent).toContain('health_stats');
  });

  /**
   * Final review. A database that is down writes no rows, so its window
   * empties; the page then said "Collecting. The first chart appears in a
   * minute." for a database with months of history.
   */
  it('does not say "collecting" for a database whose last row is old', async () => {
    state.names = ['prod'];
    const last = Date.parse('2026-10-01T02:14:00Z');
    state.read = { ok: true, histories: [history('prod', 0, {}, last)] };
    view = await render(await FleetHealth());
    expect(view.text()).not.toContain(COLLECTING);
    expect(view.text()).toContain('No readings in this window. The last was at 10-01 02:14 UTC.');
  });
});
