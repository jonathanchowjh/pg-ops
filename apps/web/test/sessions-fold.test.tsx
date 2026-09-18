import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import Sessions from '@/app/db/[name]/sessions/page';
import { APP_NAME } from '@/lib/config';

// Per-file requirement — see kill-button.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const session = (pid: number, app: string | null) => ({
  pid, state: 'idle', user: 'postgres', app, clientAddr: null,
  backendStart: null, inStateSecs: 1, queryAgeSecs: 1, query: 'SELECT 1',
});

/**
 * Whether an APPLICATION backend is connected at all. `false` is the case the
 * fold made reachable and nothing covered: a database whose only clients are
 * pgops's own pollers, which is every quiet database and every test harness.
 */
const state = vi.hoisted(() => ({ anyApp: true }));

vi.mock('@/lib/check', () => ({
  runCheckFor: vi.fn(async (_name: string, check: { id: string }) => {
    // The sessions page gained a third check in P5 (#12's diagnosis). A mock
    // that answered every call with the sessions shape handed `d.queries`
    // back as undefined and crashed the panel.
    if (check.id === 'longRunning') {
      return {
        ok: true,
        data: { queries: [], truncated: false },
        verdict: { level: 'ok' }, measuredAt: 0,
      };
    }
    if (check.id === 'connectionDetail') {
      return {
        ok: true,
        data: { connections: [], sources: [], bySslStatus: {}, total: 0, truncated: false },
        verdict: { level: 'ok' }, measuredAt: 0,
      };
    }
    return {
      ok: true,
      data: {
        sessions: [
          ...(state.anyApp ? [session(2316, 'batch-worker')] : []),
          session(3898, 'pgops'),
          session(3899, 'pgops'),
          session(3900, 'pgops-store'),
        ],
        truncated: false,
      },
      verdict: { level: 'ok' }, measuredAt: 0,
    };
  }),
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; state.anyApp = true; });

const draw = async (params: Record<string, string> = {}) => render(await Sessions({
  params: Promise.resolve({ name: 'prod' }),
  searchParams: Promise.resolve(params),
}));

/**
 * Found by reading the real screen rather than the code: with pgops's own
 * pools finally NAMED (pools.ts), this table showed three sessions from the
 * incident and nineteen of pgops's own idle connections, interleaved, each
 * carrying its own Terminate link — a console offering to kill the console.
 */
describe('Sessions — pgops does not drown out the application', () => {
  const rowPids = (r: Rendered) =>
    Array.from(r.container.querySelectorAll('tbody tr td:first-child')).map((c) => c.textContent);

  it("hides pgops's own connections by default and says how many", async () => {
    rendered = await draw();

    expect(rowPids(rendered)).toEqual(['2316']);
    // Counted, never silently dropped: pgops polling every 5s IS load on this
    // database, and a tool that removed itself from the one page showing load
    // would be lying about the thing it exists to measure.
    expect(rendered.text()).toContain('3 of pgops');
    expect(rendered.text()).toContain('hidden');
  });

  it('shows them on request, store connections included', async () => {
    rendered = await draw({ pgops: 'show' });

    expect(rowPids(rendered)).toEqual(['2316', '3898', '3899', '3900']);
    expect(rendered.text()).toContain('hide them');
  });

  /**
   * The fold must not eat an operator's limit. `?limit=10&pgops=show` that
   * came back as `?pgops=show` would silently re-widen a query they narrowed
   * on purpose — on a page whose default limit is 500 rows.
   */
  it('carries an explicit limit through the toggle', async () => {
    rendered = await draw({ limit: '10' });

    const href = Array.from(rendered.container.querySelectorAll('a'))
      .map((a) => a.getAttribute('href'))
      .find((h) => h?.includes('pgops=show'));
    expect(href).toContain('limit=10');
  });

  /**
   * The fold keys on APP_NAME, and APP_NAME is what pools.ts puts on the
   * connection. Two copies of that literal — one setting the name, one hiding
   * it — is precisely how a fold silently stops matching anything.
   */
  it('folds on the same name the pools actually set', async () => {
    expect(APP_NAME).toBe('pgops');
  });
});

describe('Sessions — when the fold empties the table', () => {
  /**
   * Caught by an integration test, not by looking: on a database whose only
   * client backends are pgops's own, the fold removes every row and what is
   * left is a table header over an empty body, with the explanation below it.
   * An empty tbody does not read as "everything here was folded" — it reads
   * as a query that returned nothing, on the page an operator opens
   * specifically to find out what is connected.
   */
  it('says so where the rows would be, not under an empty table', async () => {
    state.anyApp = false;
    rendered = await draw();

    // No empty grid left behind for the reader to interpret.
    expect(rendered.container.querySelectorAll('tbody tr')).toHaveLength(0);
    const text = rendered.text();
    expect(text).toContain('Nothing but pgops');
    expect(text).toContain('No application backend is connected right now');
    // Counted and one click away — the promise the fold made in the first place.
    expect(text).toContain('3');
    expect(rendered.container.querySelector('a[href*="pgops=show"]')).not.toBeNull();
    // Said ONCE. The footnote under the table is the same fact, and rendering
    // both leaves the reader two sentences and one situation.
    expect(text).not.toContain("of pgops's own connections hidden");
    expect(rendered.container.querySelectorAll('a[href*="pgops=show"]')).toHaveLength(1);
  });

  /**
   * A database with genuinely nothing connected is a DIFFERENT fact from one
   * whose sessions were folded, and must not borrow its sentence.
   */
  it('distinguishes an empty database from a fully folded one', async () => {
    state.anyApp = false;
    rendered = await draw({ pgops: 'show' });

    // Everything shown, so the rows are back and the empty state is gone.
    expect(rendered.container.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(rendered.text()).not.toContain('Nothing but pgops');
  });
});
