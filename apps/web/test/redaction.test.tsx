import { describe, expect, it } from 'vitest';
import { render } from './render.js';
import { Sql } from '../components/sql.js';

describe('Sql', () => {
  /**
   * §7.3: redaction matters MORE on the web than in the terminal. A screenshot
   * needs a human to take it; a URL forwards itself. A connection string in a
   * rendered query reaches everyone the link reaches.
   */
  it('redacts a password in a rendered query', async () => {
    const r = await render(<Sql>{"SELECT dblink_connect('postgres://u:hunter2@h/db')"}</Sql>);
    expect(r.text()).not.toContain('hunter2');
  });

  /**
   * F2 (final review): a redaction invariant that died with the TUI.
   * `redact.ts` scopes its quoted-literal rules to ONE LINE, and justified
   * that with "every query in a snapshot body is already single-line
   * (core/format.ts's `truncateQuery` collapses whitespace)". Task 7 deleted
   * core/format.ts along with the terminal UI, and nothing replaced it: this
   * component handed `pg_stat_activity.query` to `redactSecrets` raw,
   * newlines and all. A password with a newline in it therefore printed its
   * own tail —
   *   ALTER USER app WITH PASSWORD 'hun\nter2';  →  … PASSWORD ***\nter2';
   * — which is a secret on a URL that forwards itself.
   *
   * The fix belongs on this side of the boundary: `packages/checks` gains no
   * behaviour this phase, and a component that renders a query on a single
   * line has no business passing multi-line text to a single-line matcher.
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
   * A CLASS ASSERTION, and it is the weakest kind — but it is the only kind
   * jsdom can carry, and the defect it guards shipped invisibly.
   *
   * `ui/table`'s TableCell sets `whitespace-nowrap`, which is right for a
   * column of numbers and inherits into every statement rendered inside one.
   * With it in force the statement cannot wrap, `line-clamp-2` has no second
   * line to clamp to, and the text runs under line-clamp's own
   * `overflow: hidden` — CLIPPED MID-TOKEN, no ellipsis, on the page whose
   * whole job is showing operators what ran. Measured on /queries: the box
   * is 907px and the statement is not.
   *
   * jsdom computes no layout, so the real property — "a long statement
   * occupies two lines and ends in an ellipsis" — cannot be asserted here;
   * it was verified in a browser. What this holds is the decision: this
   * element declares its own wrapping and does not inherit the cell's.
   */
  it('does not let the table cell stop a statement wrapping', async () => {
    const r = await render(<Sql>{'SELECT 1'}</Sql>);
    const code = r.container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.className).toContain('whitespace-normal');
  });
});
