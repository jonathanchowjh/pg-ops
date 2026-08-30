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
});
