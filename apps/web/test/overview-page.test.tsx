import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Overview from '@/app/page';

// See kill-button.test.tsx: vitest gives each test FILE its own JS realm, so
// this flag is a per-file requirement rather than a one-time one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Read by the hoisted mock factory below, so each test can choose what the
// twelve incident checks answer without re-mocking the module.
const state = vi.hoisted(() => ({ mode: 'healthy' as 'healthy' | 'unreachable' | 'warn' }));

// The overview reaches configuration directly rather than through a check, so
// it awaits `connection()` itself — see the long comment on the page. Faked
// here because there is no Next request store in a unit test.
vi.mock('next/server', () => ({ connection: async () => {} }));
// <Refresh> calls useRouter() on its render path and there is no app router
// mounted in a unit test — the same shim every other page test uses.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock('@/lib/pools', () => ({ databaseNames: () => ['prod'] }));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async () => {
    if (state.mode === 'unreachable') {
      // What EVERY check returns when the host is not there. `runCheck` never
      // rejects, so a database that does not exist is twelve of these — not
      // an exception, not a partial result.
      return { ok: false, reason: 'error', message: 'database "nope" does not exist' };
    }
    if (state.mode === 'warn') {
      return { ok: true, data: {}, verdict: { level: 'warn', note: 'getting full' }, measuredAt: 0 };
    }
    return { ok: true, data: {}, verdict: { level: 'ok' }, measuredAt: 0 };
  }),
}));

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  state.mode = 'healthy';
});

describe('Overview — a verdict is earned, never assumed', () => {
  /**
   * The defect this file exists for, found by pointing the console at a
   * database that does not exist and reading the front door.
   *
   * `worstVerdict` seeded `worst = {level: 'ok'}` and only ever moved it
   * downward as checks reported. A database where every check FAILED reported
   * nothing at all, so the seed survived and the row rendered a positive OK
   * badge — directly beside its own "12 checks unavailable". The spec's rule
   * is that "we could not look" and "we looked and it's fine" must never
   * render the same, and this was the front door rendering exactly that, on
   * the page whose entire job is answering "is anything wrong anywhere?".
   *
   * Every existing test covered a database that ANSWERED. None covered one
   * that could not be reached, which is the only way to reach the seed.
   */
  it('does not claim OK for a database where every check failed', async () => {
    state.mode = 'unreachable';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).not.toContain('OK');
    expect(text).toContain('UNKNOWN');
    // The count of failed checks is reported, and it must not be reported as
    // if it were a clean bill of health.
    expect(text).toContain('unavailable');
    expect(text).toContain('could not be assessed');
  });

  it('reports OK only when a check actually returned one', async () => {
    state.mode = 'healthy';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).toContain('OK');
    expect(text).not.toContain('UNKNOWN');
    expect(text).toContain('none need attention');
  });

  /**
   * The middle level has to be distinguishable from both neighbours in TEXT,
   * not only in colour — the badge is read by screen readers, by anyone
   * colour-blind, and in grayscale screenshots.
   */
  it('names a warning as its own level and counts it as needing attention', async () => {
    state.mode = 'warn';
    rendered = await render(await Overview());

    const text = rendered.text();
    expect(text).toContain('WARN');
    expect(text).toContain('need attention');
    expect(text).not.toContain('none need attention');
  });
});
