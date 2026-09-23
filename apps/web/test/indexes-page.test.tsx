import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Indexes from '@/app/db/[name]/queries/indexes/page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The page runs ten checks, so the mock dispatches on `check.id` and each
 * test overrides only the one it is about — the other nine stay healthy,
 * which is what makes "does not render 0%" meaningful rather than vacuously
 * true on an otherwise empty page.
 */
const { overrides } = vi.hoisted(() => ({ overrides: new Map<string, unknown>() }));

const ok = (data: unknown, verdict: unknown = null) => ({ ok: true, data, verdict, measuredAt: 0 });

const HEALTHY: Record<string, unknown> = {
  indexHitRate: { rate: 99.9 },
  indexCaching: { indexes: [], total: 0, truncated: false },
  indexUsage: { tables: [], total: 0, truncated: false },
  missingIndexes: { tables: [], total: 0, truncated: false },
  unusedIndexes: { indexes: [], total: 0, truncated: false },
  invalidIndexes: { indexes: [], total: 0, truncated: false },
  duplicateIndexes: { pairs: [], total: 0, truncated: false },
  indexList: { indexes: [], total: 0, truncated: false },
  lastStatsReset: { statsReset: null },
  invalidConstraints: { constraints: [], total: 0, truncated: false },
};

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) =>
    overrides.get(check.id) ?? ok(HEALTHY[check.id] ?? {})),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  useSelectedLayoutSegment: () => 'indexes',
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  overrides.clear();
  vi.clearAllMocks();
});

// Async Server Component: CALL it, then render the element it returns.
const html = async (query: { pgops?: string } = {}) => {
  const element = await Indexes({
    params: Promise.resolve({ name: 'prod' }),
    searchParams: Promise.resolve(query),
  });
  rendered = await render(element);
  return rendered.container.innerHTML;
};

describe('the indexes page', () => {
  it('says why a check could not run instead of rendering it empty', async () => {
    overrides.set('invalidIndexes', {
      ok: false, reason: 'privilege',
      message: 'permission denied for view pg_stat_user_indexes',
    });

    const out = await html();

    expect(out).toContain('permission denied for view pg_stat_user_indexes');
    // A check that could not run must not render the sentence a healthy one does.
    expect(out).not.toContain('No invalid indexes.');
  });

  it('renders a null hit rate as unknown, never as 0%', async () => {
    overrides.set('indexHitRate', ok({ rate: null }));

    const out = await html();

    expect(out).toContain('No index I/O recorded yet.');
    expect(out).not.toMatch(/0(\.00)?%\s*of\s*(index\s*)?reads/);
  });

  /**
   * Asserts the truncation LINE, not a bare '40' — the verdict note also
   * contains 40, so a substring check would pass whether or not the page
   * ever reads `data.total`.
   */
  it('reports the true total when a list is capped', async () => {
    overrides.set('unusedIndexes', ok(
      { indexes: [{ name: 'public.ix_a', table: 'public.t', sizeBytes: 104_857_600 }],
        total: 40, truncated: true },
      { level: 'warn', note: '40 unused indexes' },
    ));

    const out = await html();

    expect(out).toContain('Showing 1 of 40');
  });

  /**
   * The other half of the truncation rule, and the half a "Showing 1 of 40"
   * assertion cannot reach: a list that is NOT capped says nothing. Without
   * this, `total <= shown` could invert and every healthy panel would read
   * "Showing 0 of 0" while the capped-list test still passed.
   */
  it('says nothing about truncation when a list is complete', async () => {
    overrides.set('unusedIndexes', ok(
      { indexes: [{ name: 'public.ix_a', table: 'public.t', sizeBytes: 104_857_600 }],
        total: 1, truncated: false },
      { level: 'warn', note: '1 unused index' },
    ));

    const out = await html();

    expect(out).toContain('public.ix_a');
    expect(out).not.toContain('Showing');
  });

  /**
   * Every capped list, in one test, because the truncation sentence is
   * rendered per panel and a per-panel test only ever covers the panel it
   * names. A mutation passing `items.length` as `total` at ONE call site
   * survived a suite that tested only the unused-indexes panel; counting the
   * sentences makes all eight call sites load-bearing at once.
   */
  it('reports the true total on every capped list, not just one of them', async () => {
    const idx = (n: string) => ({ name: n, table: 'public.t', sizeBytes: 1024 });
    overrides.set('invalidIndexes', ok({ indexes: [idx('public.a')], total: 9, truncated: true }));
    overrides.set('unusedIndexes', ok({ indexes: [idx('public.b')], total: 9, truncated: true }));
    overrides.set('indexList', ok({
      indexes: [{ ...idx('public.c'), definition: 'CREATE INDEX c ON t (v)', unique: false, primary: false }],
      total: 9, truncated: true }));
    overrides.set('indexCaching', ok({
      indexes: [{ name: 'public.d', table: 'public.t', hitRate: 50 }], total: 9, truncated: true }));
    overrides.set('duplicateIndexes', ok({
      pairs: [{ name: 'public.e', coveredBy: 'public.f', table: 'public.t', sizeBytes: 1024 }],
      total: 9, truncated: true }));
    overrides.set('invalidConstraints', ok({
      constraints: [{ name: 'c_a', table: 'public.t', definition: 'CHECK ((a > 0)) NOT VALID' }],
      total: 9, truncated: true }));
    const usage = { tables: [{ table: 'public.t', indexHitRate: 50, estimatedRows: 10 }],
                    total: 9, truncated: true };
    overrides.set('indexUsage', ok(usage));
    overrides.set('missingIndexes', ok(usage));

    const out = await html();

    expect(out.match(/Showing 1 of 9/g) ?? []).toHaveLength(8);
  });

  /**
   * `null` on a table row means the table has NO indexes at all, which is a
   * different finding from "0% of its scans used one" — and the one most
   * worth seeing, since it is the table an index might be missing from.
   * indexes.ts keeps the two apart; the page must not merge them.
   */
  it('renders a table with no indexes as such, not as 0% index scans', async () => {
    overrides.set('missingIndexes', ok({
      tables: [{ table: 'public.noidx', indexHitRate: null, estimatedRows: 50_000 }],
      total: 1, truncated: false }));

    const out = await html();

    expect(out).toContain('no indexes');
    expect(out).not.toContain('0% index scans');
  });

  it('links to the bloat route rather than running it inline', async () => {
    const out = await html();

    expect(out).toContain('/db/prod/queries/indexes/bloat');
    const { runCheckFor } = await import('@/lib/check');
    const ids = vi.mocked(runCheckFor).mock.calls.map((c) => (c[1] as { id: string }).id);
    // "Reached by an explicit click" (§5) means this page never fetches it.
    expect(ids).not.toContain('indexBloat');
  });

  it('links to suggested indexes rather than planning a hundred shapes inline', async () => {
    const out = await html();
    expect(out).toContain('/db/prod/queries/indexes/suggested');
  });

  /**
   * A hygiene route must not inherit the incident pages' 5s catalog scan.
   * guards.test.ts holds the polling set; this is the page-level statement of
   * the same fact, so a <Refresh> added here fails twice.
   */
  it('does not poll', async () => {
    const out = await html();
    expect(out).not.toContain('data-refresh');
    expect(out.toLowerCase()).not.toContain('refreshing');
  });

  /**
   * Findings first, inventory last. An operator opening this page is asking
   * "is anything wrong?", and the full index list is the reference material
   * they consult after the answer, not before it.
   */
  it('puts the findings above the inventory', async () => {
    const out = await html();
    const invalid = out.indexOf('Invalid indexes');
    const list = out.indexOf('All indexes');
    expect(invalid).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(invalid).toBeLessThan(list);
  });

  it('renders unvalidated constraints beside the invalid indexes', async () => {
    overrides.set('invalidConstraints', ok(
      { constraints: [{ name: 'child_fk', table: 'public.child',
                        definition: 'FOREIGN KEY (parent_id) REFERENCES parent(id) NOT VALID' }],
        total: 1, truncated: false },
      { level: 'warn', note: '1 unvalidated constraint' },
    ));

    const out = await html();

    expect(out).toContain('child_fk');
    expect(out).toContain('NOT VALID');
  });

  it('reports a never-reset database as never, not as an epoch', async () => {
    const out = await html();
    expect(out).toContain('Never');
    expect(out).not.toContain('1970');
  });
});

/**
 * pgops's own relations, folded out of the lists an operator reads.
 *
 * The case is not hypothetical: the documented single-database setup points
 * the console at the database that is also its store, and every catalog scan
 * then returns the tool's own indexes alongside the application's.
 */
describe('the pgops fold', () => {
  const unused = (...names: string[]) => ok({
    indexes: names.map((name) => ({ name, table: 'public.t', sizeBytes: 8192 })),
    total: names.length,
    truncated: false,
  });

  it('hides its own indexes and says how many it hid', async () => {
    overrides.set('unusedIndexes', unused('public.orders_idx', 'pgops.query_stats_captured_at_idx'));
    const out = await html();
    expect(out).toContain('public.orders_idx');
    expect(out).not.toContain('pgops.query_stats_captured_at_idx');
    // Counted, never silently dropped: pgops's schema is really in this
    // database and really does take space.
    expect(rendered!.text()).toContain("1 more is pgops's own, hidden");
  });

  it('shows them on ?pgops=show, and offers the way back', async () => {
    overrides.set('unusedIndexes', unused('public.orders_idx', 'pgops.query_stats_captured_at_idx'));
    const out = await html({ pgops: 'show' });
    expect(out).toContain('pgops.query_stats_captured_at_idx');
    expect(rendered!.text()).toContain('hide them');
  });

  it('says nothing at all when none of the rows are its own', async () => {
    overrides.set('unusedIndexes', unused('public.orders_idx'));
    await html();
    expect(rendered!.text()).not.toContain("pgops's own");
  });

  /**
   * THE VERDICT IS NOT FOLDED, and this is the property that keeps the fold
   * honest. A check's verdict is computed in `packages/checks` over every row
   * its SQL returned — so the triage line can say "2 unused indexes" while
   * this page draws one. Filtering the check instead would hide pgops's cost
   * from pgops's own numbers, which is exactly what the Sessions page refuses
   * to do.
   */
  it('leaves the check\'s own verdict counting every row', async () => {
    overrides.set('unusedIndexes', {
      ...unused('public.orders_idx', 'pgops.query_stats_captured_at_idx'),
      verdict: { level: 'warn', note: '2 unused indexes' },
    });
    await html();
    expect(rendered!.text()).toContain('2 unused indexes');
  });
});

/**
 * The panels that find things and judge nothing.
 *
 * Fifteen of the twenty-one hygiene checks reach no verdict by design, which
 * left the panels with the most rows in them as the least marked things on
 * the page: "Duplicate indexes" listing nine redundant indexes had a bare
 * heading while "Index cache hit rate" carried a green badge for having
 * nothing to report.
 */
describe('the count chip', () => {
  it('marks a verdict-less panel with how many it found', async () => {
    overrides.set('duplicateIndexes', ok({
      pairs: [
        { name: 'public.a_idx', table: 'public.t', sizeBytes: 8192, coveredBy: 'public.b_idx' },
        { name: 'public.c_idx', table: 'public.t', sizeBytes: 8192, coveredBy: 'public.d_idx' },
      ],
      total: 2,
      truncated: false,
    }));
    await html();
    const chip = [...rendered!.container.querySelectorAll('[data-slot="badge"]')]
      .find((b) => b.textContent === '2');
    expect(chip).toBeDefined();
    // Neutral. Colour on this console means a threshold was crossed, and
    // there is no threshold here — that is what `verdict: null` means.
    expect(chip!.getAttribute('data-variant')).toBe('secondary');
  });

  it('shows no chip when the panel found nothing', async () => {
    await html();
    const chips = [...rendered!.container.querySelectorAll('[data-variant="secondary"]')];
    expect(chips).toHaveLength(0);
  });

  /** A check that judged has something stronger to say, and says it alone. */
  it('yields to a verdict rather than competing with it', async () => {
    overrides.set('unusedIndexes', {
      ...ok({
        indexes: [{ name: 'public.orders_idx', table: 'public.t', sizeBytes: 8192 }],
        total: 1,
        truncated: false,
      }),
      verdict: { level: 'warn', note: '1 unused index' },
    });
    await html();
    const badges = [...rendered!.container.querySelectorAll('[data-slot="badge"]')]
      .map((b) => `${b.getAttribute('data-variant')}:${b.textContent}`);
    expect(badges).toContain('warning:WARN');
    expect(badges).not.toContain('secondary:1');
  });
});
