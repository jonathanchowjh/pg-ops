import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Tables from '@/app/db/[name]/queries/tables/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const HEALTHY: Record<string, unknown> = {
  tableHitRate: { rate: 99.9 },
  tableCaching: { tables: [], total: 0, truncated: false },
  unusedTables: { tables: [], total: 0, truncated: false },
  tableStats: { tables: [], total: 0, truncated: false },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {})),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'tables',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  overrides.clear();
  vi.clearAllMocks();
});

const html = async () => {
  const element = await Tables({ params: Promise.resolve({ name: 'prod' }) });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the tables page', () => {
  it('renders a null table hit rate as unknown, never as 0%', async () => {
    overrides.set('tableHitRate', ok({ rate: null }));

    const out = await html();

    expect(out).toContain('No heap I/O recorded yet.');
    expect(out).not.toMatch(/0(\.00)?%/);
  });

  it('says why a check could not run instead of rendering it empty', async () => {
    overrides.set('unusedTables', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_stat_user_tables',
    });

    const out = await html();

    expect(out).toContain('permission denied for view pg_stat_user_tables');
    expect(out).not.toContain('Every table with indexes has had at least one index scan');
  });

  /**
   * The caveat the plan asked for, corrected to the filter the check actually
   * uses. Task 7 established that #35 is pgHero's `idx_scan = 0`, and that
   * `idx_scan` is NULL — not 0 — for a table with no indexes at all, so every
   * such table is excluded. An empty panel therefore does NOT mean "no unused
   * tables", and the page has to say which question it answered.
   */
  it('explains what the empty unused-tables panel does not cover', async () => {
    const out = await html();

    expect(out).toContain('no indexes at all');
    expect(out).toContain('may need an index');
  });

  it('reports the true total when a list is capped', async () => {
    overrides.set('tableStats', ok({
      tables: Array.from({ length: 100 }, (_, n) => ({
        table: `public.t${n}`, liveRows: 10, deadRows: 0,
        lastVacuum: null, lastAutovacuum: null, lastAnalyze: null, lastAutoanalyze: null,
      })),
      total: 250, truncated: true,
    }));

    const out = await html();

    expect(out).toContain('Showing 100 of 250');
  });

  /**
   * All three capped lists in one test. A per-panel truncation assertion only
   * covers the panel it names: mutating `total` at the unused-tables and
   * table-caching call sites survived a suite that tested only tableStats.
   * Counting the sentences makes every call site load-bearing at once.
   */
  it('reports the true total on every capped list, not just one of them', async () => {
    overrides.set('unusedTables', ok({
      tables: [{ table: 'public.a', estimatedRows: 10 }], total: 9, truncated: true }));
    overrides.set('tableCaching', ok({
      tables: [{ table: 'public.b', hitRate: 50 }], total: 9, truncated: true }));
    overrides.set('tableStats', ok({
      tables: [{ table: 'public.c', liveRows: 1, deadRows: 0,
                 lastVacuum: null, lastAutovacuum: null,
                 lastAnalyze: null, lastAutoanalyze: null }],
      total: 9, truncated: true }));

    const out = await html();

    expect(out.match(/Showing 1 of 9/g) ?? []).toHaveLength(3);
  });

  it('says nothing about truncation when a list is complete', async () => {
    overrides.set('unusedTables', ok({
      tables: [{ table: 'public.t', estimatedRows: 5 }], total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('public.t');
    expect(out).not.toContain('Showing');
  });

  /**
   * All four maintenance timestamps mean "never" when null, which is the
   * finding on a keep-up panel. An epoch date would be a fabricated one.
   */
  it('renders a never-vacuumed table as never, not as an epoch', async () => {
    overrides.set('tableStats', ok({
      tables: [{
        table: 'public.t', liveRows: 600, deadRows: 400,
        lastVacuum: null, lastAutovacuum: null, lastAnalyze: null, lastAutoanalyze: null,
      }],
      total: 1, truncated: false,
    }));

    const out = await html();

    expect(out).toContain('Never');
    expect(out).not.toContain('1970');
  });

  it('shows live and dead tuple counts', async () => {
    overrides.set('tableStats', ok({
      tables: [{
        table: 'public.t', liveRows: 600, deadRows: 400,
        lastVacuum: new Date('2026-09-14T02:00:00Z'), lastAutovacuum: null,
        lastAnalyze: null, lastAutoanalyze: null,
      }],
      total: 1, truncated: false,
    }));

    const out = await html();

    expect(out).toContain('600');
    expect(out).toContain('400');
  });

  /** Per-table caching keeps the same null discipline as the summary above it. */
  it('renders a table with no heap I/O as no reads yet, not 0%', async () => {
    overrides.set('tableCaching', ok({
      tables: [{ table: 'public.untouched', hitRate: null }], total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('no reads yet');
    expect(out).not.toContain('0.00%');
  });

  it('does not poll', async () => {
    const out = await html();
    expect(out).not.toContain('data-refresh');
    expect(out.toLowerCase()).not.toContain('refreshing');
  });
});
