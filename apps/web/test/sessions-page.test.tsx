import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Sessions from '@/app/db/[name]/sessions/page';

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
const connectionDetailState = vi.hoisted(() => ({
  sources: [] as Array<{
    database: string | null; user: string | null; source: string | null;
    ip: string | null; connections: number; key: string;
  }>,
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

let rendered: Rendered | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  connectionDetailState.sources = [];
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
