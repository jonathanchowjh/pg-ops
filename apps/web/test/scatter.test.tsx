import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render';
import { Scatter } from '@/components/scatter';
import type { Mark } from '@/lib/plot';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mark = (id: string, over: Partial<Mark> = {}): Mark =>
  ({ id, label: id, x: 10, y: 1000, flag: false, weight: 1, href: `/db/prod/tables/${id}`, lines: ['8 KB size'], ...over });
const axes = { x: { label: 'rows written', unit: 'compact' as const }, y: { label: 'size', unit: 'bytes' as const } };

let view: Rendered;
afterEach(() => { view.unmount(); });
const dots = () => [...view.container.querySelectorAll<HTMLElement>('[data-dot]')];

describe('the scatter', () => {
  it('draws a point for each mark, a link where it has a page, and names it', async () => {
    view = await render(<Scatter {...axes} marks={[mark('public.users'), mark('public.orders', { href: null, x: 1000 })]} />);
    expect(dots()).toHaveLength(2);
    expect(dots().filter((d) => d.tagName === 'A').map((d) => d.getAttribute('href'))).toEqual(['/db/prod/tables/public.users']);
    expect(view.text()).toContain('public.users');
    expect(view.text()).toContain('rows written');
  });

  it('leaves a label off when it would cover another, and keeps the heavier', async () => {
    view = await render(<Scatter {...axes} marks={[mark('public.users', { weight: 2 }), mark('public.orders')]} />);
    expect(view.text()).toContain('users');
    expect(view.text()).not.toContain('public.orders');
    expect(dots()).toHaveLength(2);
  });

  it('puts a point with no x in the band, and names the band', async () => {
    view = await render(<Scatter {...axes} band="none" marks={[mark('a', { x: null }), mark('b')]} />);
    expect(view.container.querySelectorAll('[data-band]')).toHaveLength(1);
    expect(view.text()).toContain('none');
  });

  it('reads a point out under the pointer, and stops when it leaves', async () => {
    view = await render(<Scatter {...axes} marks={[mark('public.users')]} />);
    await act(async () => { dots()[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(view.container.querySelector('[role=tooltip]')!.textContent).toBe('public.users8 KB size');
    await act(async () => { dots()[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(view.container.querySelector('[role=tooltip]')).toBeNull();
  });

  // Review Focus 3.
  it('says how many points it did not draw', async () => {
    view = await render(<Scatter {...axes} marks={[...Array(2_050)].map((_, i) => mark(`t${i}`, { label: '', href: null }))} />);
    expect(dots()).toHaveLength(2_000);
    expect(view.text()).toContain('50 more not drawn');
  });

  it('rules a line of equal cost where it crosses the plot', async () => {
    view = await render(
      <Scatter {...axes} marks={[mark('a', { x: 1, y: 1 }), mark('b', { x: 100, y: 100 })]} iso={[{ product: 100, label: '0.1 not idle' }, { product: 1e9, label: 'off the plot' }]} />,
    );
    expect(view.container.querySelectorAll('line')).toHaveLength(1);
    expect(view.text()).toContain('0.1 not idle');
    expect(view.text()).not.toContain('off the plot');
  });

  it('rules a byte axis at round binary units, never at powers of ten printed as "9.8 KB"', async () => {
    view = await render(<Scatter {...axes} marks={[mark('a', { y: 8_192 }), mark('b', { y: 20e9 })]} />);
    const rules = [...view.container.querySelectorAll('i[aria-hidden] > span')].map((s) => s.textContent!).filter((t) => / [KMGT]?B$/.test(t));
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const r of rules) expect(r).toMatch(/^(1|10|100) (B|KB|MB|GB|TB)$/);
  });

  it('says so when there is nothing to plot', async () => {
    view = await render(<Scatter {...axes} marks={[]} />);
    expect(view.text()).toContain('nothing to plot');
  });
});
