import { afterEach, describe, expect, it } from 'vitest';
import { render, type Rendered } from './render.js';
import { SortLink } from '@/components/sort-link';
import { withParam } from '@/lib/url';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let rendered: Rendered | undefined;
afterEach(() => { rendered?.unmount(); rendered = undefined; });

describe('withParam', () => {
  /**
   * The same promise `foldFrom` makes and for the same reason: flipping one
   * control on a page reached with a search and a fold must not silently
   * discard either. A sort link that drops `q` turns "sort these four
   * matches" into "sort the whole database", which looks like the search
   * having been ignored.
   */
  it('carries every other parameter', () => {
    expect(withParam('/db/prod/tables', { q: 'order', pgops: 'show' }, 'sort', 'dead'))
      .toEqual({ pathname: '/db/prod/tables', query: { q: 'order', pgops: 'show', sort: 'dead' } });
  });

  it('replaces the parameter it is given rather than appending it', () => {
    expect(withParam('/p', { sort: 'size' }, 'sort', 'name').query).toEqual({ sort: 'name' });
  });

  it('drops the parameter when the value is undefined or empty', () => {
    expect(withParam('/p', { sort: 'size', q: 'x' }, 'q', undefined).query).toEqual({ sort: 'size' });
    expect(withParam('/p', { sort: 'size', q: 'x' }, 'q', '').query).toEqual({ sort: 'size' });
  });

  it('drops empty incoming values too, so the URL does not grow noise', () => {
    expect(withParam('/p', { q: '', sort: undefined }, 'sort', 'size').query).toEqual({ sort: 'size' });
  });
});

describe('SortLink', () => {
  const props = { pathname: '/db/prod/tables', params: { q: 'order' } };

  it('marks the active column for a screen reader, not by colour alone', async () => {
    rendered = await render(
      <SortLink label="Dead rows" column="dead" current="dead" {...props} />,
    );
    const el = rendered.container.querySelector('[aria-sort]');
    expect(el?.getAttribute('aria-sort')).toBe('descending');
    expect(rendered.text()).toContain('Dead rows');
  });

  it('leaves an inactive column unsorted', async () => {
    rendered = await render(
      <SortLink label="Size" column="size" current="dead" {...props} />,
    );
    expect(rendered.container.querySelector('[aria-sort]')?.getAttribute('aria-sort')).toBe('none');
  });
});
