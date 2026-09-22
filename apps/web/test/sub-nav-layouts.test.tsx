import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render.js';
import QueriesLayout from '@/app/db/[name]/queries/layout';
import CleanupLayout from '@/app/db/[name]/cleanup/layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Inside a tab's layout, the hook answers the segment below the tab — which
// is what it returns here. (Inside a PAGE it answers nothing at all: a page
// has no segments below it. That is why the strip lives in these layouts.)
vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: () => 'indexes',
}));

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

const hrefs = (r: Rendered) => [...r.container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');

describe('the tab layouts', () => {
  it('Queries renders its strip above the page', async () => {
    rendered = await render(await QueriesLayout({
      params: Promise.resolve({ name: 'prod' }), children: <p>the page</p>,
    }));
    expect(hrefs(rendered)).toEqual([
      '/db/prod/queries', '/db/prod/queries/indexes', '/db/prod/queries/tables', '/db/prod/queries/explain',
    ]);
    expect(rendered.container.querySelector('[aria-current="page"]')?.getAttribute('href'))
      .toBe('/db/prod/queries/indexes');
    expect(rendered.text()).toContain('the page');
  });

  it('Cleanup renders its strip above the page', async () => {
    rendered = await render(await CleanupLayout({
      params: Promise.resolve({ name: 'prod' }), children: <p>the page</p>,
    }));
    expect(hrefs(rendered)).toEqual([
      '/db/prod/cleanup', '/db/prod/cleanup/space', '/db/prod/cleanup/maintenance', '/db/prod/cleanup/sequences',
    ]);
    expect(rendered.text()).toContain('the page');
  });
});
