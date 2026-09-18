import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import QueryDetail from '@/app/db/[name]/queries/[queryid]/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { series, runSeriesFor } = vi.hoisted(() => ({
  series: new Map<string, unknown>(),
  runSeriesFor: vi.fn(),
}));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async () => ({ ok: true, data: {}, verdict: null, measuredAt: 0 })),
  runSeriesFor: runSeriesFor.mockImplementation(async (_n: string, s: { id: string }) =>
    series.get(s.id) ?? { ok: true, points: [], readAt: 0 }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  series.clear();
  vi.clearAllMocks();
});

const show = async (queryid: string) => {
  const el = await QueryDetail({ params: Promise.resolve({ name: 'prod', queryid }) });
  rendered = await render(el);
  return rendered;
};

describe('/queries/[queryid]', () => {
  it('charts calls and total time over the window', async () => {
    series.set('queryShapeHistory', {
      ok: true, readAt: 0,
      points: [
        { from: new Date('2026-09-17T00:00:00Z'), to: new Date('2026-09-17T00:05:00Z'),
          calls: 20, totalExecTime: 300, rows: 20, sharedBlksHit: 0, sharedBlksRead: 0 },
        { from: new Date('2026-09-17T00:05:00Z'), to: new Date('2026-09-17T00:10:00Z'),
          calls: 40, totalExecTime: 900, rows: 40, sharedBlksHit: 0, sharedBlksRead: 0 },
      ],
    });
    const r = await show('1234567890');
    expect(r.text()).toContain('1234567890');
    // Two series, two charts: calls and total exec time.
    expect(r.container.querySelectorAll('polyline')).toHaveLength(2);
    // The latest interval stated as a fact, not only drawn.
    expect(r.text()).toContain('40');
  });

  /**
   * §3.5: an interval spanning a reset or an LRU eviction is DROPPED, and a
   * shape whose every interval was dropped therefore has no points. That is
   * not "no history" and not a failure — it is "we have captures but none of
   * them are comparable", and it is the one case where silence would be a lie.
   */
  it('distinguishes a shape with no comparable intervals from a failure', async () => {
    series.set('queryShapeHistory', { ok: true, points: [], readAt: 0 });
    const r = await show('404');
    expect(r.text()).toMatch(/no comparable history|statistics were reset/i);
    expect(r.text()).not.toMatch(/could not/i);
  });

  it('states the remedy when there is no store at all', async () => {
    series.set('queryShapeHistory', {
      ok: false, reason: 'missing-store',
      message: 'queryShapeHistory needs the pgops store, which is not configured.',
      remedy: 'Set PGOPS_STORE_URL to a Postgres database pgops may create its own schema in.',
    });
    const r = await show('1234567890');
    expect(r.text()).toContain('PGOPS_STORE_URL');
  });

  /**
   * §5.1's bound, asserted on what the page asked for. Twenty-four hours at the
   * five-minute cadence is 288 snapshots; a page that forgets the bound renders
   * identically against a two-interval fixture.
   */
  it('bounds the read and asks for the shape in the URL', async () => {
    await show('1234567890');
    const opts = runSeriesFor.mock.calls[0]![3] as { maxSnapshots?: number; queryid: string };
    expect(opts.queryid).toBe('1234567890');
    expect(opts.maxSnapshots).toBeGreaterThan(0);
  });

  it('does not poll', async () => {
    const r = await show('1234567890');
    expect([...r.container.querySelectorAll('button')].map((b) => b.textContent))
      .not.toContain('Refresh');
  });
});
