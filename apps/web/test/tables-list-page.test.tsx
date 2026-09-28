import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Tables from '@/app/db/[name]/tables/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides, calls } = vi.hoisted(() => ({
  overrides: new Map<string, unknown>(),
  calls: [] as { id: string; opts: unknown }[],
}));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name, sizeBytes: 4096, liveRows: 10, deadRows: 0, seqScans: 0, idxScans: 5,
  hitRate: 0.99, lastVacuum: null, lastAnalyze: null, ...over,
});

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }, opts: unknown) => {
    calls.push({ id: check.id, opts });
    return overrides.get(check.id) ?? ok({ tables: [], total: 0, truncated: false });
  }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'tables',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount(); rendered = undefined;
  overrides.clear(); calls.length = 0; vi.clearAllMocks();
});

const html = async (search: Record<string, string> = {}) => {
  const element = await Tables({
    params: Promise.resolve({ name: 'prod' }),
    searchParams: Promise.resolve(search),
  });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the tables list', () => {
  it('asks the check for the largest tables by default', async () => {
    await html();
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'size' });
  });

  /**
   * THE WHOLE POINT OF SERVER-SIDE SORTING (spec §6.2). The sort must reach
   * the check, because the check applies it before its LIMIT. A page that
   * accepted `?sort=` and sorted the returned rows would pass a rendering
   * test and still show the ranking of the wrong population.
   */
  it('passes the requested sort to the check rather than sorting rows itself', async () => {
    await html({ sort: 'dead' });
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'dead' });
  });

  /**
   * An unknown sort is interpolated into an ORDER BY by the check, which
   * throws on a miss. The page must never let one through — this is the test
   * that makes `TABLE_SORTS` load-bearing rather than decorative.
   */
  it('ignores a sort it does not recognise instead of passing it on', async () => {
    await html({ sort: '; DROP TABLE orders --' });
    expect(calls.find((c) => c.id === 'tableList')?.opts).toMatchObject({ sort: 'size' });
  });

  it('passes the search and the unused filter to the check', async () => {
    await html({ q: 'order', only: 'unused' });
    expect(calls.find((c) => c.id === 'tableList')?.opts)
      .toMatchObject({ search: 'order', unusedOnly: true });
  });

  it('links each table to its own page', async () => {
    overrides.set('tableList', ok({ tables: [entry('public.orders')], total: 1, truncated: false }));
    const out = await html();
    expect(out).toContain('/db/prod/tables/public.orders');
  });

  it('reports the true total when the list is capped', async () => {
    overrides.set('tableList', ok({
      tables: Array.from({ length: 100 }, (_, n) => entry(`public.t${n}`)),
      total: 250, truncated: true,
    }));
    expect(await html()).toContain('Showing 100 of 250');
  });

  it('says why the check could not run instead of rendering an empty list', async () => {
    overrides.set('tableList', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_stat_user_tables',
    });
    expect(await html()).toContain('permission denied for view pg_stat_user_tables');
  });

  /**
   * `hitRate: null` is "no heap I/O has been recorded", not a hit rate of
   * zero. Rendering it as 0% claims the worst reading there is for a table
   * nobody has read.
   */
  it('renders an unmeasured hit rate as unknown, never as 0%', async () => {
    overrides.set('tableList', ok({
      tables: [entry('public.fresh', { hitRate: null })], total: 1, truncated: false,
    }));
    const out = await html();
    expect(out).not.toMatch(/0(\.0)?%/);
  });

  it('offers the presets as links that carry the search', async () => {
    const out = await html({ q: 'order' });
    expect(out).toContain('sort=vacuum');
    expect(out).toContain('only=unused');
    expect(out).toContain('q=order');
  });
});
