import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from './render.js';

// These two pages call `connection()` themselves. Outside a Next request
// there is no request store and the real one throws, so it is stubbed to the
// no-op it is inside a real request.
vi.mock('next/server', () => ({ connection: async () => {} }));

// `notFound()` throws distinguishably, so a test fails if the configuration
// branch does not run instead of it. `useRouter` is here because the layout's
// import graph imports it at module scope.
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND_WAS_CALLED'); },
  useRouter: () => ({ refresh: () => {} }),
}));

const CONFIG_VARS = ['PGOPS_CONFIG_FILE', 'PGOPS_DATABASES', 'DATABASE_URL'];

/**
 * A `ConfigError` escaping `databaseNames()` uncaught would give Next's
 * generic 500, leaving the message only in the container log. The page
 * functions are called directly: a throw instead of an element is visible here.
 */
describe('a misconfigured console', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('renders the configuration error on the overview instead of a generic 500', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    const { default: Overview } = await import('@/app/page');

    const r = await render(await Overview({ searchParams: Promise.resolve({}) }));

    expect(r.text()).toContain('No database configured');
    // The operator's own inputs, named.
    expect(r.text()).toContain('PGOPS_DATABASES');
  });

  it('renders the configuration error on a database page instead of a 404 or a 500', async () => {
    for (const v of CONFIG_VARS) vi.stubEnv(v, undefined);
    const { default: DbLayout } = await import('@/app/db/[name]/layout');

    const r = await render(
      await DbLayout({ children: null, params: Promise.resolve({ name: 'primary' }) }),
    );

    // Not a 404: that sends the operator to check the URL when the deployment
    // is what is broken.
    expect(r.text()).toContain('No database configured');
  });
});
