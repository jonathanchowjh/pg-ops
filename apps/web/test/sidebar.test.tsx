import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from './render';
import { Sidebar } from '@/components/sidebar';
import { NodeHead } from '@/components/node-head';
import { PAGES } from '@/components/sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ segment: null as string | null }));
vi.mock('next/navigation', () => ({ useSelectedLayoutSegment: () => nav.segment }));

let view: Rendered;
afterEach(() => { view.unmount(); });
const current = () => [...view.container.querySelectorAll('[aria-current=page]')].map((a) => a.textContent);

describe('the sidebar', () => {
  it('lists the fleet, then the database by name, then its pages', async () => {
    nav.segment = null;
    view = await render(<Sidebar name="prod" />);
    const links = [...view.container.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([['Fleet', '/'], ['prod', '/db/prod'], ...PAGES.slice(1).map((p) => [p.label, `/db/prod${p.href}`])]);
  });

  it('lights the database on the tree, and nothing else', async () => {
    nav.segment = null;
    view = await render(<Sidebar name="prod" />);
    expect(current()).toEqual(['prod']);
  });

  it('lights a page by its segment, however deep under it the reader is', async () => {
    nav.segment = 'queries';
    view = await render(<Sidebar name="prod" />);
    expect(current()).toEqual(['Queries']);
  });

  it('lights Queries on Explain, which is addressed under it', async () => {
    nav.segment = 'explain';
    view = await render(<Sidebar name="prod" />);
    expect(current()).toEqual(['Queries']);
  });

  it('carries no count and no mark', async () => {
    nav.segment = null;
    view = await render(<Sidebar name="prod" />);
    expect(view.text()).not.toMatch(/\d/);
  });
});

describe('a node head', () => {
  it('prints the ancestors only, each a link ending in a chevron, above the name', async () => {
    view = await render(
      <NodeHead mono title="public.users" crumb={[{ label: 'prod', href: '/db/prod' }, { label: 'Tables', href: '/db/prod/tables' }]} />,
    );
    expect(view.container.querySelector('nav')!.textContent).toBe('prod › Tables › ');
    expect(view.container.querySelector('nav')!.textContent).not.toContain('public.users');
    expect(view.container.querySelector('h1')!.textContent).toBe('public.users');
  });

  it('has no crumb on a page with no ancestor', async () => {
    view = await render(<NodeHead title="Fleet" crumb={[]} />);
    expect(view.container.querySelector('nav')).toBeNull();
  });
});
