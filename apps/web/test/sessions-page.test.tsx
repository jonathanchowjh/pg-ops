import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';
import Sessions from '@/app/db/[name]/sessions/page';

// See kill-button.test.tsx for the full explanation. Vitest gives each test
// FILE its own JS realm, so that file's flag doesn't carry over here — this
// is a per-file requirement, not a one-time one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The page's only Postgres-touching call. Faked so the test never needs a
// real connection() / Next request store — Sessions itself never calls
// connection() directly, only runCheckFor does (see lib/check.ts), so
// replacing this one seam is enough to exercise the page as a plain
// function returning a plain element.
vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async () => ({
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
  })),
}));

// KillButton (rendered only in the canAct:true case below) calls
// useRouter() unconditionally in its own module body's render path.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

afterEach(() => vi.unstubAllEnvs());

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
    const { container, text } = await render(element);

    const terminate = container.querySelector('button');
    expect(terminate).not.toBeNull();
    expect(text()).toContain('Terminate');
  });

  /**
   * Ruling 2: not rendered-and-disabled, not rendered at all. A disabled
   * button would still pass a weaker assertion like "no fetch happened" or
   * "no enabled button" — this checks for the complete absence of any
   * button in the row, which a disabled substitute would fail.
   */
  it('renders no terminate control at all when actions are disallowed', async () => {
    vi.stubEnv('PGOPS_ALLOW_ACTIONS', 'false');
    const element = await Sessions({
      params: Promise.resolve({ name: 'primary' }),
      searchParams: Promise.resolve({}),
    });
    const { container, text } = await render(element);

    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('button[disabled]')).toHaveLength(0);
    expect(text()).not.toContain('Terminate');
  });
});
