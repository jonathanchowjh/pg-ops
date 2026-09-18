import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Queries from '@/app/db/[name]/queries/page';

// See sessions-page.test.tsx / kill-button.test.tsx: this is a per-file
// requirement, not a one-time one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mutable, read by the mock factory below (vi.hoisted makes closing over it
// from inside a hoisted vi.mock safe — and BASE_ROW has to live inside the
// same vi.hoisted call, since vi.mock's hoisting runs before ordinary
// top-level const declarations). Defaults to one row; the empty-list test
// overrides it to prove `query-stats.ts`'s `sort: 'total'` fallback on zero
// rows never reaches the page as a "sorted by …" label — see the describe
// block below.
const { BASE_ROW, rowsState, seriesState } = vi.hoisted(() => {
  const BASE_ROW = {
    queryid: '1', query: 'select 1', calls: 100, totalMs: 2000, meanMs: 20,
    stddevMs: 0, rows: 100, cacheHitPct: 100, redacted: false,
  };
  const seriesState: { result: unknown } = {
    result: { ok: false, reason: 'missing-store', message: 'no store' },
  };
  return { BASE_ROW, rowsState: { rows: [BASE_ROW] as (typeof BASE_ROW)[] }, seriesState };
});

// The page's only Postgres-touching call. Faked the same way sessions-page.test.tsx
// does it, so the page runs as a plain function over a plain data shape.
vi.mock('@/lib/check', () => ({
  // `runSeriesFor` is mocked alongside `runCheckFor` because the page now
  // calls both through the same seam. Defaults to missing-store, which is
  // what makes the since-last-capture column ABSENT below.
  runSeriesFor: vi.fn(async () => seriesState.result),
  runCheckFor: vi.fn(async (_name: string, _check: unknown, opts: { sort: string }) => ({
    ok: true,
    data: {
      rows: rowsState.rows,
      totalShapes: rowsState.rows.length,
      sort: opts.sort,
      statsResetAt: null,
    },
    verdict: { level: 'ok' },
    measuredAt: 0,
  })),
}));

// Refresh calls useRouter() unconditionally in its own module body's render path.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  // Added when the Queries tab gained a SubNav. `vi.mock` replaces the WHOLE
  // module, so every hook anywhere in the page's tree has to be supplied
  // here — omitting this one failed all eight tests in this file with
  // `No "useSelectedLayoutSegment" export is defined on the "next/navigation"
  // mock`, which names the hook but not the component that introduced it.
  // `null` is the segment on the tab's own page, which is the page under test.
  useSelectedLayoutSegment: () => null,
}));

let rendered: Rendered | undefined;

afterEach(() => {
  // Task 8 — the sessions page picked this up when it started rendering
  // <Refresh>, and this page already does: without an unmount, each test
  // leaves a live 5-second setInterval running past the test that created it.
  rendered?.unmount();
  rendered = undefined;
  rowsState.rows = [BASE_ROW];
  seriesState.result = { ok: false, reason: 'missing-store', message: 'no store' };
});

describe('the Queries tab is extended, not replaced', () => {
  /**
   * The WIRING, which neither sub-nav.test.tsx nor the rest of this file
   * covers: that component test renders SubNav directly, so deleting
   * `<SubNav>` from this page would leave it green. This is the assertion
   * that goes red.
   */
  it('renders the sub-route strip on the tab itself', async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    const html = rendered.container.innerHTML;
    expect(html).toContain('/db/primary/queries/indexes');
    expect(html).toContain('/db/primary/queries/tables');
  });

  /**
   * /queries is an incident page and guards.test.ts asserts it polls. The
   * strip is additive: the tab keeps its content and its refresh.
   */
  it('keeps the poll and the query table it already had', async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    expect(rendered.text()).toContain('sorted by total');
    expect(rendered.text()).toContain('select 1');
  });
});

describe('Queries page — default sort', () => {
  /**
   * Fix 3: this branch briefly defaulted to 'mean' and was reverted back to
   * 'total' — the ordering this page shipped with in an earlier phase. A
   * default an operator relies on, with no test naming it, is how it flips
   * again by accident with nobody noticing until a later review.
   */
  it('sorts by total when no ?sort= is given', async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    expect(rendered.text()).toContain('sorted by total');
  });

  it('honors an explicit ?sort= override', async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({ sort: 'calls' }),
    });
    rendered = await render(element);
    expect(rendered.text()).toContain('sorted by calls');
  });

  /**
   * Re-review follow-up: `query-stats.ts`'s `map` falls back to
   * `sort: 'total'` when there are zero rows (there is no `requested_sort`
   * to read back from an empty result). That fallback is a real value on
   * `d.sort` regardless of what `?sort=` actually asked for, so the page
   * must not render "sorted by …" against an empty list — nothing was
   * ordered, and doing so would assert a `?sort=mean` request was honored
   * as `'total'` instead.
   */
  it('does not claim a sort was applied to an empty list', async () => {
    rowsState.rows = [];
    const element = await Queries({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({ sort: 'mean' }),
    });
    rendered = await render(element);
    expect(rendered.text()).toContain('0 statement shape(s)');
    expect(rendered.text()).not.toMatch(/sorted by/);
  });
});

describe('the since-last-capture column', () => {
  it('is ABSENT, not empty, when no store is configured', async () => {
    // A blank delta column reads as "this query has not moved". It means
    // "we never looked" — the distinction this project refuses to blur.
    seriesState.result = { ok: false, reason: 'missing-store', message: 'no store' };
    const ui = await Queries({
      params: Promise.resolve({ name: 'default' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(ui);
    expect(rendered.text()).not.toMatch(/since last capture/i);
  });

  it('says so when a store IS configured but could not be read', async () => {
    // The column disappearing for both "no store" and "broken store" made a
    // deployment whose store filled its disk render byte-identically to one
    // with no store at all — while the scheduler failed every five minutes
    // into a stderr nobody watches. runSeriesFor distinguishes missing-store
    // from every other reason precisely so the page does not have to blur it.
    seriesState.result = {
      ok: false, reason: 'error', message: 'no space left on device',
    };
    const ui = await Queries({
      params: Promise.resolve({ name: 'default' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(ui);
    expect(rendered.text()).toMatch(/could not be read/i);
    expect(rendered.text()).toMatch(/no space left on device/);
    // Still no column: a blank delta cell would read as "has not moved".
    expect(rendered.text()).not.toMatch(/since last capture/i);
  });

  it('renders the delta for a shape the store has two captures for', async () => {
    seriesState.result = {
      ok: true,
      readAt: 0,
      points: [{
        queryid: '1', query: 'select 1',
        intervals: [{ from: new Date(0), to: new Date(1), calls: 42,
          totalExecTime: 10, rows: 42, sharedBlksHit: 0, sharedBlksRead: 0 }],
      }],
    };
    const ui = await Queries({
      params: Promise.resolve({ name: 'default' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(ui);
    expect(rendered.text()).toMatch(/since last capture/i);
    expect(rendered.text()).toMatch(/42 calls/);
  });
});

/**
 * Which shape the "Slow queries" sentence is about.
 *
 * That panel said "1 of 53 shapes average 20ms or more over 100+ calls" and
 * the table beneath it listed all 53 with nothing to say which one it meant.
 * The operator was handed a count and left to re-derive a two-column
 * conjunction by eye, during an incident, on the page that exists to name the
 * expensive query.
 */
describe('Queries page — the slow shapes are marked, not just counted', () => {
  const draw = async (sort = 'total') => render(await Queries({
    params: Promise.resolve({ name: 'prod' }),
    searchParams: Promise.resolve({ sort }),
  }));

  it('marks exactly the shapes the slow-query filter selected', async () => {
    rowsState.rows = [
      { ...BASE_ROW, queryid: 'a', query: 'select slow', calls: 500, meanMs: 40 },
      // Fails on mean only — the conjunction's other axis.
      { ...BASE_ROW, queryid: 'b', query: 'select chatty', calls: 5000, meanMs: 1 },
      // Fails on calls only. A one-off expensive statement is not a slow
      // query, and marking it would contradict the sentence above the table.
      { ...BASE_ROW, queryid: 'c', query: 'select rare', calls: 3, meanMs: 900 },
    ];
    rendered = await draw();

    const marked = Array.from(rendered.container.querySelectorAll('tbody tr'))
      .filter((tr) => tr.textContent?.includes('SLOW'))
      .map((tr) => tr.textContent);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('select slow');
    // And the count in the sentence agrees with the number of marks.
    expect(rendered.text()).toContain('1 of 3 shapes average');
  });

  it('marks nothing when nothing qualifies', async () => {
    rowsState.rows = [{ ...BASE_ROW, calls: 5, meanMs: 1 }];
    rendered = await draw();
    expect(rendered.text()).not.toContain('SLOW');
    expect(rendered.text()).toContain('No shape averages');
  });
});

describe('each shape links to its own history', () => {
  /**
   * `pg_stat_statements.queryid` is nullable — a row whose text could not be
   * normalised has none — and the check passes that null through. A link to
   * `/queries/null` would 404 into a page that can only ever say "no history",
   * so a row with no queryid gets no link at all.
   */
  it('links a shape with a queryid, and links nothing when there is none', async () => {
    rowsState.rows = [
      { ...BASE_ROW, queryid: '1234567890', query: 'select 1' },
      { ...BASE_ROW, queryid: null as unknown as string, query: 'select 2' },
    ];
    const element = await Queries({
      params: Promise.resolve({ name: 'prod' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);

    const hrefs = [...rendered.container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/db/prod/queries/1234567890');
    expect(hrefs).not.toContain('/db/prod/queries/null');
    // Exactly one of the two rows is linked. Matched on a numeric last
    // segment, not on the prefix: the SubNav above the table already renders
    // /db/prod/queries/indexes and /db/prod/queries/tables, which share it.
    expect(hrefs.filter((h) => /^\/db\/prod\/queries\/\d+$/.test(h)).length).toBe(1);
  });
});
