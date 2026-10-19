import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Sql } from '../components/sql.js';

describe('Sql', () => {
  /** A connection string in a rendered query reaches everyone the page's URL reaches. */
  it('redacts a password in a rendered query', async () => {
    const r = await render(<Sql>{"SELECT dblink_connect('postgres://u:hunter2@h/db')"}</Sql>);
    expect(r.text()).not.toContain('hunter2');
  });

  /**
   * `redact.ts` scopes its quoted-literal rules to one line, so the component
   * must not hand it multi-line text. Otherwise a password with a newline in
   * it prints its own tail:
   *   ALTER USER app WITH PASSWORD 'hun\nter2';  →  … PASSWORD ***\nter2';
   */
  it('redacts a secret that a newline splits across two lines', async () => {
    const r = await render(<Sql>{"ALTER USER app WITH PASSWORD 'hun\nter2';"}</Sql>);
    expect(r.text()).not.toContain('ter2');
    expect(r.text()).toContain('***');
  });

  it('renders an em dash for a null query rather than the word null', async () => {
    const r = await render(<Sql>{null}</Sql>);
    expect(r.text()).toBe('—');
  });

  it('leaves an ordinary query intact', async () => {
    const r = await render(<Sql>{'SELECT 1'}</Sql>);
    expect(r.text()).toBe('SELECT 1');
  });

  /**
   * `ui/table`'s TableCell sets `whitespace-nowrap`, which inherits into a
   * statement rendered inside one: it cannot wrap, `line-clamp-2` has no
   * second line, and the text is clipped mid-token with no ellipsis. jsdom
   * computes no layout, so this only holds that the element declares its own
   * wrapping.
   */
  it('does not let the table cell stop a statement wrapping', async () => {
    const r = await render(<Sql>{'SELECT 1'}</Sql>);
    const code = r.container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.className).toContain('whitespace-normal');
  });
});
