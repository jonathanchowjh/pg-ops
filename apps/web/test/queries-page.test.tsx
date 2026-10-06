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
const { BASE_ROW, rowsState, seriesState, loadState, ratesState } = vi.hoisted(() => {
  const BASE_ROW = {
    queryid: '1', query: 'select 1', calls: 100, totalMs: 2000, meanMs: 20,
    stddevMs: 0, rows: 100, cacheHitPct: 100, redacted: false,
  };
  const seriesState: { result: unknown } = {
    result: { ok: false, reason: 'missing-store', message: 'no store' },
  };
  // The 24-hour load chart, off by default for the same reason the
  // since-last-capture column is: no store.
  const loadState: { result: unknown } = { result: { ok: false, message: 'History is off.' } };
  // Task 2: what `ratesFor` would hand back for this render. `null` by
  // default — the ordinary "only one sample so far" state — and overridden
  // by the Throughput describe block below.
  const ratesState: { value: unknown } = { value: null };
  return {
    BASE_ROW, rowsState: { rows: [BASE_ROW] as (typeof BASE_ROW)[] }, seriesState, loadState, ratesState,
  };
});

// The page's only Postgres-touching call. Faked the same way sessions-page.test.tsx
// does it, so the page runs as a plain function over a plain data shape.
vi.mock('@/lib/load', () => ({
  LOAD_HOURS: 24,
  queryLoadFor: vi.fn(async () => loadState.result),
}));

// Task 2: mocked separately from `@/lib/check` so a test can control the
// RATE directly, with no need to drive two renders through the real
// differencing logic just to get a non-null one.
vi.mock('@/lib/rates', () => ({ ratesFor: vi.fn(() => ratesState.value) }));

vi.mock('@/lib/check', () => ({
  // `runSeriesFor` is mocked alongside `runCheckFor` because the page now
  // calls both through the same seam. Defaults to missing-store, which is
  // what makes the since-last-capture column ABSENT below.
  runSeriesFor: vi.fn(async () => seriesState.result),
  runCheckFor: vi.fn(async (_name: string, check: { id: string }, opts?: { sort: string }) => {
    // Task 2: the page now fetches a second check beside queryStats. Its
    // own data never reaches the page directly — `ratesFor` is mocked above
    // and does the reading — so a minimal, always-valid shape is enough here.
    if (check.id === 'databaseActivity') {
      return {
        ok: true,
        data: {
          xactCommit: 0, xactRollback: 0, deadlocks: 0, conflicts: 0, tempFiles: 0, tempBytes: 0,
          blksRead: 0, blksHit: 0, tupReturned: 0, tupFetched: 0, tupInserted: 0, tupUpdated: 0, tupDeleted: 0,
          statsResetAt: null, sampledAt: '2026-01-01T00:00:00Z',
        },
        verdict: null,
        measuredAt: 0,
      };
    }
    return {
      ok: true,
      data: {
        rows: rowsState.rows,
        totalShapes: rowsState.rows.length,
        // Task 8: pgops's own shapes, folded out of `rows` by default and
        // counted here regardless — see the describe block below that pins
        // the fold's surface on this page.
        ownShapes: 3,
        sort: opts!.sort,
        statsResetAt: null,
      },
      verdict: { level: 'ok' },
      measuredAt: 0,
    };
  }),
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
  loadState.result = { ok: false, message: 'History is off.' };
  ratesState.value = null;
});

describe('the Queries tab is extended, not replaced', () => {
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
    expect(rendered.text()).toContain('0 statement shapes');
    expect(rendered.text()).not.toMatch(/sorted by/);
  });
});

/**
 * Task 2's panel on this page. `ratesFor` is mocked directly (see the
 * hoisted `ratesState` above) rather than driven through two real renders,
 * because the real differencing needs a second sample and this page is a
 * pure function of whatever `ratesFor` hands back.
 */
describe('Queries page — throughput', () => {
  it('states throughput for the last interval, or that it needs one more refresh', async () => {
    ratesState.value = null;
    rendered = await render(await Queries({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).toContain('rates after the next refresh');
    // 3_355_443 B is 3.2 MiB; formatBytes divides by 1024.
    ratesState.value = { seconds: 5, commitsPerSec: 312.4, rollbacksPerSec: 2, deadlocks: 1, tempBytesPerSec: 3_355_443, cacheHitPct: 98.7, tuplesPerSec: 900 };
    rendered = await render(await Queries({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('312 commits/s');
    expect(t).toContain('2 rollbacks/s');
    expect(t).toContain('1 deadlock');
    expect(t).toContain('3.2 MB/s to temp files');
    expect(t).toContain('98.7% cache hit');
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
    // segment, not on the prefix, so a link to a sub-route never counts.
    expect(hrefs.filter((h) => /^\/db\/prod\/queries\/\d+$/.test(h)).length).toBe(1);
  });
});

/**
 * Task 8: the console's own catalog reads otherwise rank among the top
 * statement shapes on the very page that exists to show what the DATABASE is
 * doing. `queryStats` folds them out of `rows` by default and counts them in
 * `ownShapes` regardless — this is the fold's surface on the page, the same
 * shape sessions-page.test.tsx pins for pgops's own connections.
 */
describe('Queries page — the console folds its own statement shapes', () => {
  it('says how many of the console\'s own shapes are hidden, with a way to show them', async () => {
    rendered = await render(await Queries({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).toContain("3 of pgops's own statement shapes hidden");
    expect(rendered.container.innerHTML).toContain('pgops=show');
  });
});

/**
 * #20 and #31's surface. Both live here, in one panel, on purpose: an
 * operator needs to know that resetting STATEMENT statistics is not the same
 * as resetting the database's TABLE and INDEX statistics, and two controls
 * with distinct wording side by side teach that where two controls on two
 * routes would not.
 */
describe('the statistics controls', () => {
  const show = async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'prod' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    return rendered;
  };

  afterEach(() => { delete process.env.PGOPS_ALLOW_ACTIONS; });

  it('offers both resets, named for what each one clears', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    const r = await show();
    const labels = [...r.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Reset query statistics');
    expect(labels).toContain('Reset database statistics');
  });

  it('offers neither when actions are disabled', async () => {
    const r = await show();
    const labels = [...r.container.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Reset query statistics');
    expect(labels).not.toContain('Reset database statistics');
  });

  /**
   * The two are easy to confuse and one is much broader. The page has to say
   * which is which BEFORE the press, because afterwards the only evidence is
   * a stats_reset timestamp.
   */
  it('says what each reset actually clears', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    const r = await show();
    expect(r.text()).toMatch(/pg_stat_statements|statement statistics/i);
    expect(r.text()).toMatch(/table and index statistics/i);
  });

  /**
   * A10. With actions enabled, the first thing on this page was a bordered
   * box carrying two captions and two danger strings — about seventy words
   * about destroying statistics, above every number the page exists to show.
   * An operator opening Queries mid-incident met a destructive control
   * before a single reading.
   *
   * Asserted by POSITION in the rendered text, which is the claim: the
   * controls come after the data they destroy. A test for their mere
   * presence passed with them at the top, which is how they shipped.
   */
  it('puts the resets after the data they destroy', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    const r = await show();
    const t = r.text();
    expect(t.indexOf('Query statistics')).toBeGreaterThan(-1);
    expect(t.indexOf('Reset query statistics')).toBeGreaterThan(t.indexOf('Query statistics'));
    expect(t.indexOf('Reset query statistics')).toBeGreaterThan(t.indexOf('Throughput'));
  });

  /**
   * And behind a disclosure, so the danger strings are not prose the page
   * carries at rest. Same shape as Settings on the Cleanup page: one
   * deliberate click.
   */
  it('keeps them behind a disclosure rather than open on the page', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    const r = await show();
    const details = r.container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details!.querySelector('summary')!.textContent).toContain('Reset statistics');
    expect(details!.textContent).toContain('Reset query statistics');
  });
});

/**
 * The one thing on this page that is not about a shape.
 *
 * Every other number here ranks statements against each other, which answers
 * "what is worst" and not "is this unusual" — and during an incident the
 * second question decides whether the ranking matters at all.
 */
describe('the 24-hour load chart', () => {
  const at = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000);

  const show = async () => {
    const element = await Queries({
      params: Promise.resolve({ name: 'prod' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    return rendered;
  };

  it('draws the series when the store has one', async () => {
    loadState.result = {
      ok: true,
      points: [
        { capturedAt: at(15), totalExecTime: 1_200, calls: 400 },
        { capturedAt: at(10), totalExecTime: 2_400, calls: 800 },
        { capturedAt: at(5), totalExecTime: 900, calls: 300 },
      ],
    };
    const r = await show();
    expect(r.container.querySelector('polyline')).not.toBeNull();
    expect(r.text()).toContain('Execution time per capture interval');
  });

  /**
   * Execution time alone rises for two unrelated reasons with opposite
   * fixes — the database got slower, or more traffic arrived — and the pair
   * is what tells them apart. `calls` has been in `query_load` since
   * migration 004 and in `StoredLoad` all along; only the chart was missing.
   */
  it('charts calls beside execution time, because time alone is ambiguous', async () => {
    loadState.result = {
      ok: true,
      points: [
        { capturedAt: at(15), totalExecTime: 1_200, calls: 400 },
        { capturedAt: at(10), totalExecTime: 2_400, calls: 800 },
        { capturedAt: at(5), totalExecTime: 900, calls: 300 },
      ],
    };
    const r = await show();
    expect(r.text()).toContain('Calls per capture interval');
    expect(r.container.querySelectorAll('polyline')).toHaveLength(2);
    // The calls axis is labelled with the calls, not with milliseconds.
    expect(r.text()).toContain('800');
  });

  /**
   * Silent with no store, exactly as the since-last-capture column is — and
   * silent when the store is BROKEN, because the sentence above the table
   * already says so once. Two reports of one failure is worse than one.
   */
  it('is absent with no store, and says nothing extra when the store is broken', async () => {
    const off = await show();
    expect(off.container.querySelector('polyline')).toBeNull();
    off.unmount();

    loadState.result = { ok: false, message: 'could not read history' };
    const broken = await show();
    expect(broken.container.querySelector('polyline')).toBeNull();
    expect(broken.text()).not.toContain('could not read history');
  });

  /**
   * One capture is not an interval, and an interval is what the chart draws.
   * A one-point series would render an empty SVG — a chart that silently
   * disappears rather than saying why.
   */
  it('says what it is waiting for when there is only one capture', async () => {
    loadState.result = { ok: true, points: [{ capturedAt: at(3), totalExecTime: 5, calls: 1 }] };
    const r = await show();
    expect(r.container.querySelector('polyline')).toBeNull();
    expect(r.text()).toContain('needs two captures');
  });
});

/**
 * A9. Before this, the only link on a ranked row was the CALLS COUNT — so
 * the path from "this statement is slow" to "here is its plan" was select,
 * copy, open Explain, paste. The statement itself, the thing an operator
 * reads the row for, was the one part that was not clickable.
 *
 * Two destinations now, both reached from the statement: its history, and
 * its plan.
 */
describe('a ranked statement reaches its plan in one click', () => {
  it('offers Explain on every row whose text was readable', async () => {
    rowsState.rows = [
      { ...BASE_ROW, queryid: '1', query: 'select 1' },
      { ...BASE_ROW, queryid: '2', query: 'select 2' },
    ];
    rendered = await render(await Queries({
      params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}),
    }));
    const explains = [...rendered.container.querySelectorAll('button')]
      .filter((b) => b.textContent === 'Explain');
    expect(explains).toHaveLength(2);
  });

  /**
   * `redacted` means Postgres withheld the text from this role. There is
   * nothing to explain, and a control that handed an empty statement to the
   * Explain form would be a button that cannot work.
   */
  it('offers no Explain on a row whose text this role may not read', async () => {
    rowsState.rows = [
      { ...BASE_ROW, queryid: '1', query: null as unknown as string, redacted: true },
    ];
    rendered = await render(await Queries({
      params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}),
    }));
    const t = rendered.text();
    expect(t).toContain('insufficient privilege');
    expect([...rendered.container.querySelectorAll('button')].filter((b) => b.textContent === 'Explain'))
      .toHaveLength(0);
  });

  /**
   * The statement carries the link to history now, and the calls count has
   * given its link up: two links per row to the same place is the echo this
   * console cuts, and of the two the statement is what an operator is
   * actually pointing at.
   */
  it('links the statement to its history, and the calls count no longer duplicates it', async () => {
    rowsState.rows = [{ ...BASE_ROW, queryid: '77', query: 'select 1', calls: 1234 }];
    rendered = await render(await Queries({
      params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}),
    }));
    const history = [...rendered.container.querySelectorAll('a')]
      .filter((a) => a.getAttribute('href') === '/db/prod/queries/77');
    expect(history).toHaveLength(1);
    expect(history[0]!.textContent).toContain('select 1');
    expect(history[0]!.textContent).not.toContain('1,234');
  });

  /**
   * A row with no queryid has no history page to reach, but its text is
   * readable, so the plan is still one click away. The two destinations are
   * independent and the row must not lose both because it lost one.
   */
  it('still offers Explain on a row that has no history to link to', async () => {
    rowsState.rows = [{ ...BASE_ROW, queryid: null as unknown as string, query: 'select 2' }];
    rendered = await render(await Queries({
      params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}),
    }));
    expect([...rendered.container.querySelectorAll('button')].filter((b) => b.textContent === 'Explain'))
      .toHaveLength(1);
  });
});
