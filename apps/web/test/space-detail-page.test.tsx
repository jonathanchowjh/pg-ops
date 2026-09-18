import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import RelationSpace from '@/app/db/[name]/cleanup/space/[relation]/page';

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
  useSelectedLayoutSegment: () => 'space',
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered = undefined; series.clear(); vi.clearAllMocks(); });

const show = async (relation: string) => {
  const el = await RelationSpace({ params: Promise.resolve({ name: 'prod', relation }) });
  rendered = await render(el);
  return rendered;
};

describe('/cleanup/space/[relation]', () => {
  it('names the relation and charts its captured sizes', async () => {
    series.set('relationSpace', {
      ok: true, readAt: 0,
      points: [
        { capturedAt: new Date('2026-09-01T00:00:00Z'), sizeBytes: 1_073_741_824 },
        { capturedAt: new Date('2026-09-17T00:00:00Z'), sizeBytes: 3_221_225_472 },
      ],
    });
    const r = await show('public.events');
    expect(r.text()).toContain('public.events');
    expect(r.text()).toContain('3 GB');
    expect(r.container.querySelector('polyline')).not.toBeNull();
  });

  /**
   * §5.1's bound, asserted on what the page actually asked for. Thirty days at
   * the five-minute cadence is 8,640 points for ONE relation; a page that
   * forgets to pass the bound renders identically against a two-point fixture,
   * so the fixture cannot catch it and the call args have to.
   */
  it('bounds the read rather than asking for every capture in thirty days', async () => {
    await show('public.events');
    const opts = runSeriesFor.mock.calls[0]![3] as { maxPoints?: number; relation: string };
    expect(opts.maxPoints).toBeGreaterThan(0);
    expect(opts.relation).toBe('public.events');
  });

  /**
   * No history is a READING, not a failure. A relation created since the last
   * capture has none, and saying "could not read" would send an operator to
   * check a store that is working fine.
   */
  it('says there is no history yet rather than reporting a failure', async () => {
    series.set('relationSpace', { ok: true, points: [], readAt: 0 });
    const r = await show('public.brand_new');
    expect(r.text()).toMatch(/no history/i);
    expect(r.text()).not.toMatch(/could not/i);
  });

  it('states the remedy when there is no store at all', async () => {
    series.set('relationSpace', {
      ok: false, reason: 'missing-store',
      message: 'relationSpace needs the pgops store, which is not configured.',
      remedy: 'Set PGOPS_STORE_URL to a Postgres database pgops may create its own schema in.',
    });
    const r = await show('public.events');
    expect(r.text()).toContain('PGOPS_STORE_URL');
  });

  it('carries the cleanup sub-navigation and does not poll', async () => {
    const r = await show('public.events');
    const hrefs = [...r.container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/db/prod/cleanup/space');
    expect([...r.container.querySelectorAll('button')].map((b) => b.textContent))
      .not.toContain('Refresh');
  });
});
