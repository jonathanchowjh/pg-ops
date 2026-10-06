import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKS, LONG_RUNNING_FLOOR_SECS } from '@pgops/checks';
import { render, type Rendered } from './render.js';
import Sessions from '@/app/db/[name]/sessions/page';

// Task 5: the "Recent actions" panel's only seam — see @/lib/recent-actions,
// which itself wraps `readRecentAudit` from @pgops/checks. Mocked here for
// the same reason @/lib/check is: the page should be exercisable as a plain
// function, with no real audit file on disk.
const recent = vi.hoisted(() => ({ records: [] as unknown[], unreadable: null as string | null }));
vi.mock('@/lib/recent-actions', () => ({
  recentActionsFor: vi.fn(async () => ({ records: recent.records, unreadable: recent.unreadable })),
}));

// See kill-button.test.tsx for the full explanation. Vitest gives each test
// FILE its own JS realm, so that file's flag doesn't carry over here — this
// is a per-file requirement, not a one-time one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mutable, and read by the mock factory below (which vi.mock hoists above
// this file's other top-level statements — `vi.hoisted` is what makes a
// binding safe to close over from inside it). Defaults to the empty shape
// every existing test here wants; fix 8 below overrides it per-test to get
// non-empty "Connection sources" data, which is the case that would have
// caught fix 2 and fix 4 before review — every mock in this file used to
// return the empty shape, so a null IP or a colliding key never had a row to
// render against.
const longRunningState = vi.hoisted(() => ({
  queries: [] as Array<{
    pid: number; runningSecs: number; query: string | null; backendStart: string | null;
  }>,
}));

const connectionDetailState = vi.hoisted(() => ({
  sources: [] as Array<{
    database: string | null; user: string | null; source: string | null;
    ip: string | null; connections: number; key: string;
  }>,
}));

const locksState = vi.hoisted(() => ({
  roots: [] as Array<{ pid: number; totalWaiters: number; waiters: Array<{ pid: number; cycle: boolean; waiters: never[] }> }>,
  fail: false,
}));

// Task 1: "Active now" — what the server is doing right this instant, ahead
// of Long-running. Defaults to the empty shape every existing test in this
// file wants; the two new tests below override it per-test.
const activityState = vi.hoisted(() => ({
  data: {
    active: 0,
    waits: [] as Array<{ type: string; event: string | null; sessions: number; longestSecs: number }>,
    shapes: [] as Array<{ shapeKey: string; queryId: string | null; statement: string | null; sessions: number; longestSecs: number }>,
    waitsTruncated: false,
    shapesTruncated: false,
    restricted: false,
  },
}));

// The page's only Postgres-touching call. Faked so the test never needs a
// real connection() / Next request store — Sessions itself never calls
// connection() directly, only runCheckFor does (see lib/check.ts), so
// replacing this one seam is enough to exercise the page as a plain
// function returning a plain element.
//
// Task 3 added a second runCheckFor call on this page (CHECKS.connectionDetail,
// for the "Connection sources" panel), so the mock can no longer answer every
// call identically — it must switch on which check was asked for, or the
// connectionDetail call gets the sessions shape back and the panel crashes
// reading `d.sources` off data with no such field.
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    if (check.id === 'connectionDetail') {
      return {
        ok: true,
        data: {
          connections: [],
          sources: connectionDetailState.sources,
          bySslStatus: {},
          total: connectionDetailState.sources.length,
          truncated: false,
        },
        verdict: { level: 'ok' },
        measuredAt: 0,
      };
    }
    if (check.id === 'longRunning') {
      // The verdict DELEGATES to the real check's own verdict() and
      // thresholds (packages/checks/src/checks/long-running.ts) instead of
      // reimplementing its ok/warn/critical thresholds here as a second
      // copy that can drift from them — which a hand-rolled "warn whenever
      // there's a query" version already had: it called 300s and 400s warn
      // when the real check calls them critical (>= 300, long-running.ts:132-140),
      // and nothing below noticed because nothing asserted on level. A
      // hardcoded 'ok' before that made every negative assertion about the
      // note's text unfalsifiable — the forbidden text could never appear no
      // matter what the page under test did.
      const data = { queries: longRunningState.queries, truncated: false };
      return {
        ok: true,
        data,
        verdict: CHECKS.longRunning.verdict!(data, CHECKS.longRunning.thresholds!),
        measuredAt: 0,
      };
    }
    if (check.id === 'activity') {
      return { ok: true, data: activityState.data, verdict: null, measuredAt: 0 };
    }
    if (check.id === 'locks') {
      if (locksState.fail) return { ok: false, reason: 'privilege', message: 'permission denied for pg_locks' };
      return {
        ok: true,
        data: { roots: locksState.roots, truncated: false },
        verdict: { level: 'ok' },
        measuredAt: 0,
      };
    }
    return {
      ok: true,
      data: {
        sessions: [
          {
            pid: 42,
            state: 'active',
            user: 'app_user',
            app: 'my_app',
            clientAddr: null,
            backendStart: '2026-01-01T00:00:00Z',
            inStateSecs: 5,
            queryAgeSecs: 5,
            xactAgeSecs: 30,
            query: 'select 1',
          },
        ],
        truncated: false,
      },
      verdict: { level: 'ok' },
      measuredAt: 0,
    };
  }),
}));

// KillButton (rendered only in the canAct:true case below) calls
// useRouter() unconditionally in its own module body's render path.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => '/db/prod/sessions',
}));

let rendered: Rendered | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  connectionDetailState.sources = [];
  locksState.roots = [];
  locksState.fail = false;
  longRunningState.queries = [];
  recent.records = [];
  recent.unreadable = null;
  activityState.data = { active: 0, waits: [], shapes: [], waitsTruncated: false, shapesTruncated: false, restricted: false };
  // This page renders <Refresh>, which starts a live 5-second setInterval
  // (see components/refresh.tsx). Every test here calls render() without
  // ever calling unmount(), so each one used to leave its interval running
  // past the test that created it — harmless while the suite finished in
  // well under a second, but strictly wrong, and worse with every render
  // this file adds. `container.remove()` alone (what `render` already does)
  // does not stop a `setInterval` closed over by a still-mounted component;
  // only unmounting the React root does.
  rendered?.unmount();
  rendered = undefined;
});

describe('Sessions page — the kill control gate', () => {
  /**
   * I1 (review): nothing previously rendered this page at all, so
   * `{canAct ? <KillButton .../> : null}` reverting to an unconditional
   * render, or being replaced with `<KillButton disabled={!canAct} />` (the
   * form Ruling 2 explicitly forbids), would both go undetected. A
   * source-scanning regex can't tell those two shapes apart reliably; this
   * asserts the RENDERED OUTPUT instead, per Ruling R9.
   */
  it('renders the terminate control when PGOPS_ALLOW_ACTIONS=true', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    const element = await Sessions({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);

    // Scoped to the sessions TABLE, not the page. The page header carries a
    // Refresh button of its own, so an unscoped `querySelector('button')`
    // would find that one and pass whether or not a terminate control was
    // ever rendered — the assertion would hold for the wrong reason.
    const table = rendered.container.querySelector('table')!;
    const terminate = table.querySelector('button');
    expect(terminate).not.toBeNull();
    expect(rendered.text()).toContain('Terminate');
  });

  /**
   * Ruling 2: not rendered-and-disabled, not rendered at all. A disabled
   * button would still pass a weaker assertion like "no fetch happened" or
   * "no enabled button" — this checks for the complete absence of any
   * button in the row, which a disabled substitute would fail.
   *
   * That absence is asserted over the sessions TABLE rather than the whole
   * container. It used to be the whole container, which was the same
   * statement only for as long as the page happened to contain no other
   * control; the header's Refresh button broke that coincidence. Scoping to
   * the table says what this test has always meant — "no button in the row" —
   * and keeps the property that matters: a disabled substitute still fails it.
   */
  it('renders no terminate control at all when actions are disallowed', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'false');
    const element = await Sessions({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);

    const table = rendered.container.querySelector('table')!;
    expect(table.querySelectorAll('button')).toHaveLength(0);
    expect(table.querySelectorAll('button[disabled]')).toHaveLength(0);
    expect(rendered.text()).not.toContain('Terminate');
  });

  /**
   * Task 3: the Locks page and the triage page both link a pid to
   * `/db/${name}/sessions#pid-${pid}` — a fragment that only lands the
   * operator on the right row if the row actually carries that id. Without
   * it, the link is dangling: the browser scrolls to the top of a table
   * that can hold dozens of rows.
   */
  it('gives every row an anchor a pid link can land on', async () => {
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.container.querySelector('tr#pid-42')).not.toBeNull();
  });

  /**
   * Ruling 2: the expectation is built FROM the constant, not a hardcoded
   * '60s' literal — a page that hardcoded 60 into its sentence would satisfy
   * a literal '60s' assertion just as well, defeating the reason
   * LONG_RUNNING_FLOOR_SECS is exported at all. Building the string from the
   * same import the page uses is what keeps the SQL floor, the threshold and
   * this sentence unable to drift apart.
   */
  it('shows the transaction age and states the long-running floor', async () => {
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).toContain(`Nothing running past ${LONG_RUNNING_FLOOR_SECS}s`);
    expect(rendered.container.querySelector('tr#pid-42')!.textContent).toContain('30s');
  });

  /**
   * Task 13: the row's highlight is driven by the URL fragment, not the CSS
   * `:target` pseudo-class — `:target` never matches after an App Router
   * client-side navigation, which is the one path an operator actually
   * takes. See components/row-highlight.tsx.
   */
  it('tints the row the fragment names, on a client-side arrival', async () => {
    window.location.hash = '#pid-42';
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.container.querySelector('tr#pid-42')!.className).toContain('bg-warning-surface');
    window.location.hash = '';
  });
});

describe('Sessions page — Connection sources', () => {
  /**
   * Fix 8 (final review): a page-level test with NON-EMPTY "Connection
   * sources" data would have caught both fix 2 (a null client_addr rendered
   * as the false claim 'socket') and fix 4 (a `/`-joined React key that
   * collides on an application_name containing `/`) before review — every
   * mock in this file previously returned the empty shape, so neither
   * defect ever had a row to render against.
   *
   * The auxiliary-backend row (`database: null, user: null, source: '',
   * ip: null`) is the case fix 2 is actually about: DETAIL_SQL does not
   * filter backend_type, so checkpointer/walwriter/autovacuum-launcher rows
   * reach this page with every one of those fields null — not because they
   * are unix-socket connections, but because they have no client at all.
   */
  it('renders connection sources without claiming an auxiliary backend is a socket', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'false');
    connectionDetailState.sources = [
      {
        database: null, user: null, source: '', ip: null, connections: 3,
        key: JSON.stringify(null) + '\0' + JSON.stringify(null) + '\0' + JSON.stringify('') + '\0' + JSON.stringify(null),
      },
      {
        database: 'appdb', user: 'app', source: 'web-1/checkout', ip: '10.0.0.7', connections: 2,
        key: JSON.stringify('appdb') + '\0' + JSON.stringify('app') + '\0' + JSON.stringify('web-1/checkout') + '\0' + JSON.stringify('10.0.0.7'),
      },
      {
        database: 'appdb', user: 'reporting', source: 'web-1/reports', ip: '10.0.0.8', connections: 1,
        key: JSON.stringify('appdb') + '\0' + JSON.stringify('reporting') + '\0' + JSON.stringify('web-1/reports') + '\0' + JSON.stringify('10.0.0.8'),
      },
    ];
    const element = await Sessions({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);

    expect(rendered.text()).toContain('Connection sources');
    // The one dangerous phrasing this fix removes: an auxiliary backend
    // (every field null/empty) must never read as a transport claim it has
    // no evidence for.
    expect(rendered.text()).not.toMatch(/socket/i);
    // The real content is still there — a null IP renders as the same
    // "we don't know" dash every other null field on this page already uses.
    expect(rendered.find('—')).not.toBeNull();
  });
});

/**
 * #12's surface. The bulk kill lives beside the per-session kill it is a
 * bulk version of, and the panel lists the matching sessions FIRST — that
 * diagnosis is the property separating this capability from the permanently
 * declined kill_all, so a control without the list would be the wrong thing
 * shipped under the right name.
 */
describe('the long-running panel', () => {
  const show = async () => {
    const element = await Sessions({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    rendered = await render(element);
    return rendered;
  };

  afterEach(() => { longRunningState.queries = []; delete process.env.PGOPS_ALLOW_ACTIONS; });

  it('lists the long-running sessions before offering to kill them', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    longRunningState.queries = [
      { pid: 77, runningSecs: 300, query: 'SELECT slow()', backendStart: '2026-01-01T00:00:00Z' },
    ];
    const r = await show();
    expect(r.text()).toContain('77');
    expect(r.text()).toContain('SELECT slow()');
    expect([...r.container.querySelectorAll('button')].map((b) => b.textContent))
      .toContain('Terminate all');
  });

  /**
   * Nothing, not a disabled button: a disabled control advertises a capability
   * that is switched off, which is the same disclosure the route's 404
   * prevents.
   */
  it('offers no control at all when actions are disabled', async () => {
    longRunningState.queries = [
      { pid: 77, runningSecs: 300, query: 'SELECT slow()', backendStart: '2026-01-01T00:00:00Z' },
    ];
    const r = await show();
    // The diagnosis still renders — an operator without actions still needs
    // to SEE what is running long.
    expect(r.text()).toContain('77');
    expect([...r.container.querySelectorAll('button')].map((b) => b.textContent))
      .not.toContain('Terminate all');
  });

  it('offers nothing to terminate when nothing is running long', async () => {
    process.env.PGOPS_ALLOW_ACTIONS = 'true';
    longRunningState.queries = [];
    const r = await show();
    expect([...r.container.querySelectorAll('button')].map((b) => b.textContent))
      .not.toContain('Terminate all');
  });
});

describe('Sessions page — a waiter is not a slow query', () => {
  const chain = () => {
    longRunningState.queries = [
      { pid: 103, runningSecs: 195, query: 'UPDATE users SET n = 1', backendStart: 'b' },
      { pid: 104, runningSecs: 195, query: 'DELETE FROM users', backendStart: 'b' },
    ];
    locksState.roots = [{ pid: 102, totalWaiters: 2, waiters: [
      { pid: 104, cycle: false, waiters: [] }, { pid: 103, cycle: false, waiters: [] },
    ] }];
  };

  it('marks each waiter with its root blocker and withholds Terminate all', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const text = rendered.text();
    expect(text.match(/blocked by 102/g)).toHaveLength(2);
    expect(text).toContain('Not slow — waiting');
    expect(text).not.toContain('Terminate all');
  });

  it('still offers Terminate all when one long-runner is genuinely slow', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    longRunningState.queries.push({ pid: 999, runningSecs: 400, query: 'SELECT heavy()', backendStart: 'b' });
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).toContain('Terminate all');
    expect(rendered.text()).not.toContain('Not slow — waiting');
  });

  it('falls back to the old behaviour when the lock check failed', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    locksState.fail = true;
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).toContain('Terminate all');
    expect(rendered.text()).not.toContain('Not slow — waiting');
    // Not a bare `not.toContain('blocked by')`: Task 16's caveat paragraph
    // (added below) uses that exact phrase in prose — `marked "blocked by"`
    // — to describe what is MISSING, so the substring alone no longer
    // distinguishes that from an actual per-row annotation. What this test
    // means is still true and still checked: no row names a blocker pid.
    // Not load-bearing on its own, though: with the lock check failed,
    // `stuck.blockedBy` is empty by construction (see stuckFrom), so no
    // marker could render regardless of this assertion. It exists to guard
    // against the prose colliding with the pattern again, not as evidence
    // the feature works.
    expect(rendered.text()).not.toMatch(/blocked by \d+/);
  });

  it('does not put a waiter pid in the long-running badge', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('2 waiting on 102');
    expect(t).not.toMatch(/pid 10[34] running/);
  });

  it('says the lock graph could not be read rather than showing an unblocked table', async () => {
    chain();
    locksState.fail = true;
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Lock graph unavailable');
    expect(t).toContain('privilege');
    // See the comment above the same substitution a few tests up — also not
    // load-bearing on its own, for the same reason.
    expect(t).not.toMatch(/blocked by \d+/);
  });

  it('says nothing about the lock graph when it read fine', async () => {
    chain();
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).not.toContain('Lock graph unavailable');
  });

  it('warns inside the long-running panel, above Terminate all, when the graph is unreadable', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    locksState.fail = true;
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Cannot tell which of these are waiting');
    // The ORDER is the whole point of this task: the caveat must precede the
    // control it qualifies. Task 15's paragraph satisfied `toContain` and still
    // rendered one panel below the button.
    expect(t.indexOf('Cannot tell which of these are waiting')).toBeLessThan(t.indexOf('Terminate all'));
  });

  it('says nothing in the long-running panel when the graph read fine', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    chain();
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).not.toContain('Cannot tell which of these are waiting');
  });
});

describe('Sessions page — Active now', () => {
  it('reports what the server is doing right now, ahead of the long-running list', async () => {
    activityState.data = {
      active: 42,
      waits: [{ type: 'running', event: null, sessions: 30, longestSecs: 0.4 }, { type: 'IO', event: 'DataFileRead', sessions: 12, longestSecs: 2.1 }],
      shapes: [{ shapeKey: '7', queryId: '7', statement: 'SELECT * FROM orders WHERE customer_id = $1', sessions: 40, longestSecs: 2.1 }],
      waitsTruncated: false,
      shapesTruncated: false,
      restricted: false,
    };
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('42 active');
    expect(t).toContain('30 running');
    expect(t).toContain('12 IO · DataFileRead');
    expect(t).toContain('40 ×');
    expect(t.indexOf('Active now')).toBeLessThan(t.indexOf('Long-running queries'));
    // Both flags are false in this fixture, so neither truncation note
    // should render — extended here rather than as a fourth test, since the
    // fixture already gives us the both-false case for free.
    expect(t).not.toContain('Showing the busiest 30 wait buckets.');
    expect(t).not.toContain('Showing the busiest 30 statement shapes.');
  });

  /**
   * A cut list must not read as the whole list. The panel shows 1 of 400
   * shapes; without this the operator has no way to know 399 are missing.
   *
   * Pinned to the FULL, distinct wording of each note — not a shared
   * substring like 'Showing the busiest 30' — and asserted both ways: the
   * shape note present AND the wait note absent. A loose substring
   * assertion passes even if `ActiveNow` reads the two flags backwards and
   * blames the wrong list; that misattribution is worse than saying
   * nothing, because an operator who trusts a wait profile that is
   * actually incomplete concludes the server is fine when it might not be.
   */
  it('says when the shape list was cut short, and not that the wait list was', async () => {
    activityState.data = {
      active: 900,
      waits: [{ type: 'running', event: null, sessions: 900, longestSecs: 1 }],
      shapes: [{ shapeKey: 'md5-1', queryId: null, statement: 'SELECT 1', sessions: 5, longestSecs: 1 }],
      waitsTruncated: false,
      shapesTruncated: true,
      restricted: false,
    };
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Showing the busiest 30 statement shapes.');
    expect(t).not.toContain('Showing the busiest 30 wait buckets.');
  });

  /**
   * The mirror of the test above. Without it, a mutation that hardcodes the
   * shapes note to always render — or one that simply swaps which flag
   * drives which note — would still pass the shapes-cut case above (which
   * never checks the wait note is capable of appearing at all) as long as
   * the shapes note happened to come out right there too.
   */
  it('says when the wait list was cut short, and not that the shape list was', async () => {
    activityState.data = {
      active: 900,
      waits: [{ type: 'running', event: null, sessions: 5, longestSecs: 1 }],
      shapes: [{ shapeKey: 'md5-2', queryId: null, statement: 'SELECT 1', sessions: 900, longestSecs: 1 }],
      waitsTruncated: true,
      shapesTruncated: false,
      restricted: false,
    };
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Showing the busiest 30 wait buckets.');
    expect(t).not.toContain('Showing the busiest 30 statement shapes.');
  });

  /**
   * FIX 1 (the branch-holding defect). A role without pg_read_all_stats gets
   * NULL `state` for every backend it does not own, and activity.ts's SQL
   * filters on `state = 'active'` — so `NULL = 'active'` excludes every
   * foreign backend and this panel's zero is ambiguous: it might mean
   * nothing is running, or it might mean this role could not see what is.
   * Asserted BOTH directions (restricted true and false), or a mutation that
   * always shows (or never shows) the caveat would still pass one half.
   */
  it('does not claim nothing is executing when restricted, and names the fix', async () => {
    activityState.data = { active: 0, waits: [], shapes: [], waitsTruncated: false, shapesTruncated: false, restricted: true };
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).not.toContain('Nothing is executing right now.');
    expect(t).toContain("This role can't see other sessions' state.");
    expect(t).toContain('GRANT pg_read_all_stats');
  });

  it('claims nothing is executing, with no caveat, when not restricted', async () => {
    activityState.data = { active: 0, waits: [], shapes: [], waitsTruncated: false, shapesTruncated: false, restricted: false };
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Nothing is executing right now.');
    expect(t).not.toContain("This role can't see other sessions' state.");
    expect(t).not.toContain('GRANT pg_read_all_stats');
  });
});

describe('Sessions page — the blocking marker', () => {
  /**
   * FIX 3. Nothing previously asserted that `stuck.blocking` actually
   * reaches the table: the "Not slow — waiting" paragraph promises the
   * operator "the root blocker, marked 'blocking' in the table below", and
   * `stuck.blocking.has(s.pid)` could be replaced with `false` with the
   * whole web suite still green. The fixed sessions-table row is always pid
   * 42 (see the default @/lib/check mock above), so the root blocker here is
   * made pid 42 to land the marker on that exact row.
   */
  it("marks the root blocker's own row in the sessions table with 'blocking N'", async () => {
    locksState.roots = [{ pid: 42, totalWaiters: 2, waiters: [] }];
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('blocking 2');
  });
});

/**
 * Task 5 (review finding 4): after a kill the row vanishes and with it the
 * only feedback the operator gets. The audit log already records every
 * action; this panel reads it back.
 */
describe('Sessions page — Recent actions', () => {
  it('lists recent audited actions against this database', async () => {
    recent.records = [{
      timestamp: new Date(Date.now() - 120_000).toISOString(), user: 'jc@host', action: 'kill',
      subcommand: 'web/sessions', target: { database: 'prod', pid: 102 }, reason: 'root blocker', result: 'terminated',
    }];
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Recent actions');
    expect(t).toContain('102');
    expect(t).toContain('terminated');
    expect(t).toContain('root blocker');
  });

  it('says nothing about recent actions when there are none', async () => {
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    expect(rendered.text()).not.toContain('Recent actions');
  });

  /**
   * Critical review finding: "no action has ever been taken" and "the audit
   * log could not be read" rendered identically — no panel at all — because
   * `readRecentAudit` returned `[]` for both and this component's own empty
   * check could not tell them apart. This is the one record of who
   * terminated what, so silence here is the worst case for this console's
   * `verdict: null`-is-not-`ok` rule, not a marginal one.
   */
  it('renders the panel with a caveat, not nothing, when the audit log could not be read', async () => {
    recent.records = [];
    recent.unreadable = 'EACCES';
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const t = rendered.text();
    expect(t).toContain('Recent actions');
    expect(t).toContain('Audit log unavailable');
    expect(t).toContain('EACCES');
    expect(t).toContain('not evidence that nothing was done');
  });
});

/**
 * A19. Measured in a real browser at 390x844 with the seeded lock chain
 * open: the first Terminate button sat **1292px** down the page, against an
 * 844px viewport — one and a half screens of scrolling before the operator
 * reached the control. Active now, Long-running queries and Recent actions
 * all described the incident ABOVE the table that can end it.
 *
 * Not folded the way A17 folded the triage panels. A17's fold works because
 * the Lock wait graph is on the same screen for a collapsed card to point
 * at; this page has no wait graph, which is why A16's caveat and the
 * "Not slow — waiting" paragraph both live here in full. These panels are
 * not echoes of something above them — they are simply above the thing an
 * operator came for.
 *
 * Asserted in DOM ORDER rather than with `indexOf` on the rendered text,
 * for the reason triage's ranking test gives: a grid can reorder panels
 * visually while leaving the source sequence alone, which would put the
 * table first for a sighted reader and fourth for anyone reading with a
 * screen reader or the Tab key.
 */
describe('Sessions page — the table that acts comes first', () => {
  it('leads with Sessions, then its sources, then the panels that describe it', async () => {
    // One record, so "Recent actions" renders at all and its position is
    // actually under test — with an empty log the panel is absent and the
    // assertion would pass on a page that never moved it.
    recent.records = [{
      timestamp: new Date().toISOString(), user: 'jc@host', action: 'kill',
      subcommand: 'web/sessions', target: { database: 'prod', pid: 102 },
      reason: 'root blocker', result: 'terminated',
    }];
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const headings = Array.from(rendered.container.querySelectorAll('h2')).map((h) => h.textContent);
    // Exact, not a chain of `toBeLessThan`: a panel added to this page
    // without a decision about where it goes should red this test, and a
    // panel silently dropped should too.
    expect(headings).toEqual([
      'Sessions', 'Connection sources', 'Active now', 'Long-running queries', 'Recent actions',
    ]);
  });
});

/**
 * The defect A19's own measurement exposed in the other axis. A19 moved the
 * first Terminate button from 1292px DOWN the page to 343px; the same drive
 * then found it 334px off the right edge, because `action` is the last of
 * eight columns in a table whose scroll container is 342px wide and holds
 * 725px of content.
 *
 * Worse than the vertical distance it replaced, not merely equal to it.
 * Scrolling down is the gesture a phone operator makes without being asked;
 * a table that scrolls sideways inside the page gives no hint that five more
 * columns and the only control exist at all. The cap on the query column
 * already in place was put there so "one long statement cannot push the
 * Terminate column off the right of the table" — seven columns of ordinary
 * content turned out to be enough on their own.
 *
 * Pinned to the right edge rather than moved to the second column, which
 * was the other candidate: KillButton's confirm panel is anchored
 * `right-2` and grows LEFTWARD over the query column, deliberately, so that
 * it cannot widen the table off screen. In column two it would grow left
 * over a 41px pid column and hang off the other edge — the exact defect
 * c18a97b fixed. Sticky keeps the control on screen and leaves that
 * component untouched.
 */
describe('Sessions page — the control is reachable without scrolling sideways', () => {
  it('pins the action column to the right edge of the scrolling table', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const row = rendered.container.querySelector('tr#pid-42');
    expect(row).not.toBeNull();
    const action = row!.lastElementChild!;
    expect(action.querySelector('button')?.textContent).toBe('Terminate');
    // jsdom computes no layout, so the offset itself is unassertable here —
    // it is measured in a real browser and recorded in the commit. What a
    // test CAN hold is that the cell is pinned at all, which is the part a
    // later edit would silently drop.
    expect(action.className).toContain('sticky');
    expect(action.className).toContain('right-0');
    // `bg-inherit`, not an opaque background: the row carries the highlight
    // a pid link lands on and the hover tint, and an opaque cell would cut
    // both off at this column.
    expect(action.className).toContain('bg-inherit');
    // Which requires the row to HAVE a background for the cell to inherit —
    // transparent would let the query column scroll under the buttons.
    expect(row!.className).toContain('bg-background');
  });

  it('keeps the column header named for a screen reader while it holds layout', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'true');
    rendered = await render(await Sessions({ params: Promise.resolve({ name: 'prod' }), searchParams: Promise.resolve({}) }));
    const table = rendered.container.querySelector('tr#pid-42')!.closest('table')!;
    const head = table.querySelector('thead tr')!.lastElementChild!;
    expect(head.textContent).toBe('action');
    // The name moved from `sr-only` ON the cell to an `sr-only` span INSIDE
    // it: `sr-only` sets `position: absolute`, which cannot also be sticky,
    // so the header was out of flow and could not hold the pinned column.
    expect(head.className).not.toContain('sr-only');
    expect(head.querySelector('.sr-only')?.textContent).toBe('action');
    expect(head.className).toContain('sticky');
  });
});
