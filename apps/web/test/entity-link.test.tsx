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
   * ENCODED HERE, DECODED BY NEXT, and encoded exactly once. The space page's
   * docblock records the other half of this contract: `relation` arrives
   * already decoded from Next, and decoding again corrupts a name containing
   * a literal percent. A relation name is an arbitrary identifier — a slash
   * or a percent in one is legal Postgres and would otherwise route somewhere
   * else entirely, or 404.
   */
  it('encodes a name that would otherwise change the route', async () => {
    expect(await href('public.a/b')).toBe('/db/prod/tables/public.a%2Fb');
    expect(await href('public.100%')).toBe('/db/prod/tables/public.100%25');
  });

  it('shows the name as written', async () => {
    rendered = await render(<EntityLink database="prod" name="public.order_items" />);
    expect(rendered.text()).toBe('public.order_items');
  });
});
