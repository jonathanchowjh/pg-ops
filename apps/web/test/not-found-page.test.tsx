import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import NotFound from '@/app/not-found';

// Per-file requirement — see actions.test.tsx.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({ throws: false }));

vi.mock('next/server', () => ({ connection: async () => {} }));
vi.mock('@/lib/pools', async () => {
  const { ConfigError: CE } = await import('@/lib/config');
  return {
    databaseNames: () => {
      if (state.throws) throw new CE('PGOPS_DATABASES is not valid JSON: Unexpected token }');
      return ['prod', 'analytics'];
    },
  };
});

let rendered: Rendered | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  state.throws = false;
});

describe('The 404', () => {
  /**
   * `app/db/[name]/layout.tsx` routes an unconfigured name here, so the page
   * answers what the name should have been: the names in PGOPS_DATABASES.
   */
  it('lists the database names that would have worked', async () => {
    rendered = await render(await NotFound());

    const text = rendered.text();
    expect(text).toContain('prod');
    expect(text).toContain('analytics');
    const hrefs = Array.from(rendered.container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/db/prod');
    expect(hrefs).toContain('/db/analytics');
    // And a way back.
    expect(hrefs).toContain('/');
  });

  /**
   * Any unmatched URL lands here, including on a console whose configuration
   * cannot be read, where `databaseNames()` throws. The 404 must not 500.
   */
  it('reports a broken configuration instead of throwing on top of the 404', async () => {
    state.throws = true;
    rendered = await render(await NotFound());

    const text = rendered.text();
    expect(text).toContain('cannot read its own configuration');
    expect(text).toContain('PGOPS_DATABASES is not valid JSON');
    expect(text).not.toContain('prod');
  });
});
