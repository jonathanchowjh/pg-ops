import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { EntityLink } from '@/components/entity-link';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

const href = async (name: string) => {
  rendered = await render(<EntityLink database="prod" name={name} />);
  return rendered.container.querySelector('a')?.getAttribute('href');
};

describe('EntityLink', () => {
  it('links a relation to its own page', async () => {
    expect(await href('public.orders')).toBe('/db/prod/tables/public.orders');
  });

  /**
   * Encoded here exactly once, decoded by Next. A slash or a percent is legal
   * in a Postgres identifier and would otherwise change the route or 404.
   */
  it('encodes a name that would otherwise change the route', async () => {
    expect(await href('public.a/b')).toBe('/db/prod/tables/public.a%2Fb');
    expect(await href('public.100%')).toBe('/db/prod/tables/public.100%25');
  });

  it('shows the name as written', async () => {
    rendered = await render(<EntityLink database="prod" name="public.order_items" />);
    expect(rendered.text()).toBe('public.order_items');
  });

  it('wraps what it is given, as a row\'s whole label cell', async () => {
    rendered = await render(<EntityLink database="prod" name="public.a/b" className="row"><b>label</b></EntityLink>);
    const a = rendered.container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/db/prod/tables/public.a%2Fb');
    expect(a.className).toBe('row');
    expect(a.textContent).toBe('label');
  });
});
