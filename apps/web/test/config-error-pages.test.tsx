import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';

// These two pages are the only ones that reach configuration WITHOUT going
// through `runCheckFor`, so they are the two that call `connection()`
// themselves. Outside a Next request there is no request store and the real
// `connection()` throws (see lib/check.ts's NO_REQUEST_STORE docblock) — which
// would end the test before it reached the code under test. Stubbed to a
// no-op, which is exactly what it does inside a real request.
vi.mock('next/server', () => ({ connection: async () => {} }));

// `notFound()` throws in Next too; the assertion below is that the
// configuration branch runs INSTEAD of it, so a distinguishable throw is what
// this needs. `useRouter` is here because `components/refresh.tsx` and
// `components/kill-button.tsx` import it at module scope through the layout's
// import graph — a mock missing it fails at import time, before any test runs.
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND_WAS_CALLED'); },
  useRouter: () => ({ refresh: () => {} }),
}));

const CONFIG_VARS = ['PGOPS_CONFIG_FILE', 'PGOPS_DATABASES', 'DATABASE_URL'];

/**
 * F4 (final review): Task 1's whole justification was that a configuration
 * error must name the input the operator actually set — `PGOPS_CONFIG_FILE
 * (/etc/pgops/databases.json)`, not "something went wrong". In production it
 * reached nobody: `ConfigError` escaped uncaught out of `databaseNames()` on
 * both of these routes, so Next answered with its generic 500 page and the
 * message existed only in the container log, which is the one place an
 * operator looking at a blank console does not look first.
 *
 * These call the page functions directly rather than through a server. A Next
 * page is an async function returning an element; the failure being fixed is
 * that it THREW instead of returning one, which is visible from here.
 */
describe('a misconfigured console', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('renders the configuration error on the overview instead of a generic 500', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    const { default: Overview } = await import('@/app/page');

    const r = await render(await Overview());

    expect(r.text()).toContain('No database configured');
    // The operator's own inputs, named. This is the whole point of Task 1.
    expect(r.text()).toContain('PGOPS_DATABASES');
  });

  it('renders the configuration error on a database page instead of a 404 or a 500', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    const { default: DbLayout } = await import('@/app/db/[name]/layout');

    const r = await render(
      await DbLayout({ children: null, params: Promise.resolve({ name: 'primary' }) }),
    );

    // Not a 404: with no configuration at all, "that database does not exist"
    // is a true statement that sends the operator to check the URL, when the
    // thing that is actually broken is the deployment.
    expect(r.text()).toContain('No database configured');
  });
});
